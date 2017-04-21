'use strict';

const Restify = require('restify');
const RestifyValidation = require('node-restify-validation');
const Promise = require('bluebird');
const Minimist = require('minimist');
const Moment = require('moment');
const Mime = require('mime');
const _ = require('lodash');
const Path = require('path');
const Fs = Promise.promisifyAll(require('fs'));
const FsExtra = Promise.promisifyAll(require('fs-extra'));
const SpawnShell = require('./spawn-shell');
const Url = require('url');

const DEBUG = /--debug/.test(process.argv.toString());
const argv = Minimist(process.argv.slice(2));
const AppInfo = JSON.parse(Fs.readFileSync('package.json'));

process.on('uncaughtException', (err) => {
    console.warn('uncaughtException', err);
})

function DebugLog() {
    if (!DEBUG) return;
    console.log.apply(console, arguments);
}

const PORT = argv.port || process.env.SERVER_PORT || 7000;
const HOST = argv.host || process.env.SERVER_HOST || '127.0.0.1';
const TIMEOUT = argv.timeout || process.env.TIMEOUT || 300000;
const DATA_PATH = argv.dataPath || process.env.DATA_PATH || 'repositories';

const server = Restify.createServer({
    name:    AppInfo.name,
    version: AppInfo.version
});

server.pre(Restify.pre.userAgentConnection());
server.pre(Restify.pre.sanitizePath());
server.use(Restify.CORS(['*']));
server.use(Restify.authorizationParser());
server.use(Restify.queryParser());
server.use(Restify.bodyParser({
    maxBodySize:          0,
    mapParams:            true,
    mapFiles:             false,
    overrideParams:       false,
    multipartFileHandler: function (part) {
        console.log('part', part);
        part.on('data', function (data) {
            /* do something with the multipart file data */
        });
    }
}));
server.use(RestifyValidation.validationPlugin({
    errorsAsArray: false,
    errorHandler:  Restify.errors.InvalidArgumentError
}));

server.server.setTimeout(TIMEOUT, _.noop);

// nvm workaround
let pathKey = process.env['Path'] ? 'Path' : 'PATH';
if (process.env['NVM_BIN']) {
    process.env[pathKey] += ';' + process.env['NVM_BIN'];
}
process.env[pathKey] += ';' + Path.join(__dirname, 'runtime', 'node_modules', '.bin');
process.env['NODE_PATH'] = Path.join(__dirname, 'runtime', 'node_modules');
process.env['GIT_SSL_NO_VERIFY'] = true; // bug ssl ca store not found

process.env['NAME'] = process.env['GIT_AUTHOR_NAME'] = process.env['GIT_COMMITTER_NAME'] = 'builder';
process.env['ENAIL'] = process.env['GIT_AUTHOR_EMAIL'] = process.env['GIT_COMMITTER_EMAIL'] = 'builder@easywebhub.com';

const SpawnGitShell = Promise.coroutine(function *(command, args, options) {
    options = options || {};
    // let env = _.assign({}, process.env);
    // console.log('env', env);

    DebugLog('Call Shell cmd', command, args);
    options.env = process.env;
    // DebugLog('SpawnGitShell options', options);
    return yield SpawnShell(command, args, options);
});

const ResponseSuccess = function (res, result) {
    res.json({result: result});
}

const ResponseError = function (res, error) {
    let errorMsg = typeof(error) === 'string' ? error : error.message ? error.message : error.toString();
    res.json({error: errorMsg});
}

const GetRepoInfo = function (repoUrl) {
    if (repoUrl.startsWith('git@'))
        repoUrl = 'ssh://' + repoUrl;

    let uri = Url.parse(repoUrl);
    if (uri.pathname.endsWith('.git')) {
        uri.pathname = uri.pathname.slice(0, uri.pathname.length - 4);
    }

    let parts = uri.pathname.split('/');
    if (parts.length != 3)
        throw new Error('invalid repository url');
    let ret = {
        host:    uri.host,
        group:   parts[1],
        project: parts[2],
    };

    if (ret.group.startsWith(':'))
        ret.group = ret.group.slice(1);
    return ret;
};

const GetRepoLocalPath = function (repoUrl) {
    let info = GetRepoInfo(repoUrl);
    return Path.resolve(Path.join(DATA_PATH, info.group, info.project)) + Path.sep;
};

const IsFolderExists = Promise.coroutine(function *(localPath) {
    try {
        let stat = yield Fs.statAsync(localPath);
        return stat.isDirectory();
    } catch (ex) {
        return false;
    }
});

const RemoveFolder = Promise.coroutine(function *(dir) {
    try {
        FsExtra.removeAsync(dir);
    } catch (ex) {
        console.log('RemoveFolder failed', dir);
    }
});

const IsRepoExists = Promise.coroutine(function *(repoUrl) {
    let localRepoPath = GetRepoLocalPath(repoUrl);
    let localRepoGitPath = localRepoPath + Path.sep + '.git';
    return (yield IsFolderExists(localRepoPath)) &&
        (yield IsFolderExists(localRepoGitPath));
});

const InitRootRepository = Promise.coroutine(function *(repoUrl, branch, localRepoDir) {
    if (!localRepoDir.endsWith(Path.sep))
        localRepoDir += Path.sep;
    return yield SpawnGitShell('git', ['clone', '-q', '-b', branch, repoUrl, '.'], {cwd: localRepoDir});
});

// NEW CODE START
const InitBuildRepository = Promise.coroutine(function *(repoUrl, localRepoDir) {
    if (!localRepoDir.endsWith(Path.sep))
        localRepoDir += Path.sep;
    return yield SpawnGitShell('git', ['clone', '-q', '-b', 'gh-pages', repoUrl, 'build'], {cwd: localRepoDir});
});

const checkRepoInitialized = Promise.coroutine(function*(localRepoDir) {
    let rootDotGitFolder = Path.join(localRepoDir, '.git');
    let buildDotGitFolder = Path.join(localRepoDir, 'build', '.git');
    if (!(yield IsFolderExists(rootDotGitFolder)) || !(yield IsFolderExists(buildDotGitFolder))) {
        throw new Error('repository is not initialized');
    }
});

const PullSrc = Promise.coroutine(function *(workDir) {
    if (!workDir.endsWith(Path.sep)) workDir += Path.sep;
    DebugLog(yield SpawnGitShell('git', ['fetch', '--all'], {cwd: workDir}));
    return yield SpawnGitShell('git', ['reset', '--hard', 'origin/master'], {cwd: workDir})
});


const PushRepo = Promise.coroutine(function *(workDir, branch) {
    if (!workDir.endsWith(Path.sep)) workDir += Path.sep;
    try {
        DebugLog(yield SpawnGitShell('git', ['checkout', branch], {cwd: workDir}));
        DebugLog(yield SpawnGitShell('git', ['branch', '--set-upstream-to=origin/' + branch], {cwd: workDir}));
        DebugLog(yield SpawnGitShell('git', ['pull', 'origin', branch, '-s', 'recursive', '-X', 'ours'], {cwd: workDir}));
        // add file
        DebugLog(yield SpawnGitShell('git', ['add', '.'], {cwd: workDir}));
        // commit
        let message = Moment().format('YYYY-MM-DD HH:mm:ss');
        DebugLog(yield SpawnGitShell('git', ['commit', `-m"${message}"`], {cwd: workDir}));
        return yield SpawnGitShell('git', ['push', 'origin', 'HEAD:' + branch], {cwd: workDir});
    } catch (ex) {
        let errMsg = ex.toString();
        if (errMsg.indexOf('working tree clean') !== -1)
            return errMsg;
        throw (ex);
    }
});

const BuildSrc = Promise.coroutine(function *(workDir, task) {
    if (!workDir.endsWith(Path.sep)) workDir += Path.sep;
    let gulpPath = Path.join(__dirname, 'runtime', 'node_modules', '.bin', 'gulp');
    let ret = yield SpawnGitShell(gulpPath, ['--no-color', task, '--production'], {cwd: workDir});
    let buildSuccess = ret.indexOf(`Finished '`) != -1;
    if (!buildSuccess) {
        let errorStartIndex = ret.find('Error:');
        if (errorStartIndex === -1) {
            throw new Error(ret);
        } else {
            throw new Error(ret.slice(errorStartIndex + 7));
        }
    }
    return ret;
});

// INIT
server.post({
    url: '/init', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let localRepoDir = GetRepoLocalPath(repoUrl);
        let buildFolder = Path.join(localRepoDir, 'build');
        DebugLog('Start handle "init" request, url', repoUrl);

        // check if repo exist and valid
        let isLocaclFolderExists = yield IsFolderExists(localRepoDir);
        let isBuildFolderExists = yield IsFolderExists(buildFolder);
        if (isLocaclFolderExists === true && isBuildFolderExists === true) {
            return ResponseSuccess(res, 'exists');
        }

        // remove repos url if exists
        RemoveFolder(localRepoDir);
        // create folder
        try {
            yield FsExtra.ensureDirAsync(localRepoDir + Path.sep);
        } catch (ex) {
        }

        // parallel clone root and build folder
        // git clone root
        let tasks = [
            InitRootRepository(repoUrl, 'master', localRepoDir), // init root folder
        ];
        // delay a bit for folder to be created
        tasks.push(InitBuildRepository(repoUrl, localRepoDir)); // clone build folder

        Promise.all(tasks).then(resp => {
            DebugLog('git init root and build folder success', resp);
            ResponseSuccess(res, 'ok');
        }).catch(err => {
            DebugLog('git init root and build folder failed', err);
            ResponseError(res, err);
        })

        // remove build folder, không cần thiết nếu template đúng chuẩn
        // RemoveFolder(buildFolder);
    } catch (ex) {
        DebugLog('init failed', ex);
        ResponseError(res, ex);
    }
}));

// PULL-SRC
server.post({
    url: '/pull-src', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let localRepoDir = GetRepoLocalPath(repoUrl);

        DebugLog(yield PullSrc(localRepoDir));
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        DebugLog('pull-src failed', ex);
        ResponseError(res, ex);
    }
}));

// BUILD SRC
server.post({
    url: '/build', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true},
            task:    {isRequired: false, isIn: ['metalsmith', 'build']}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let task = req.params.task || 'build';
        let repoUrl = req.params.repoUrl;
        let localRepoDir = GetRepoLocalPath(repoUrl);
        DebugLog(yield BuildSrc(localRepoDir, task));
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        DebugLog('build', ex);
        ResponseError(res, ex);
    }
}));

// PUSH SRC
server.post({
    url: '/push-src', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let pushBranch = req.params.pushBranch;
        let localRepoDir = GetRepoLocalPath(repoUrl);

        DebugLog(yield PushRepo(localRepoDir, 'master'));
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        DebugLog('push-src', ex);
        ResponseError(res, ex);
    }
}));

// PUSH BUILT
server.post({
    url: '/push-built', validation: {
        resources: {
            repoUrl:    {isRequired: true, isUrl: true},
            pushBranch: {isRequired: false, isRegex: /[a-zA-Z0-9\-_]/}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let pushBranch = req.params.pushBranch || 'gh-pages';

        let localRepoDir = GetRepoLocalPath(repoUrl);
        let buildFolder = localRepoDir + 'build' + Path.sep;

        DebugLog(yield PushRepo(buildFolder, pushBranch));

        ResponseSuccess(res, 'ok');
    } catch (ex) {
        DebugLog('push-built failed', ex);
        ResponseError(res, ex);
    }
}));

function trimRootFolder(dir) {
    let parts = dir.split('/');
    parts.shift();
    return parts.join('/');
}

// LIST FILE
let ScanDir = Promise.coroutine(function *(siteRoot, dir, ret, filter) {
    try {
        let files = yield Fs.readdirAsync(dir);
        for (let name of files) {
            let fullPath = Path.join(dir, name);
            let stat = Fs.statSync(fullPath);

            let isDir = stat.isDirectory();
            if (filter && typeof(filter) === 'function')
                if (filter(name, isDir) == false)
                    continue;

            if (isDir) {
                yield ScanDir(siteRoot, fullPath, ret, filter);
            } else {
                ret.push({
                    name: name,
                    path: trimRootFolder(Path.relative(siteRoot, fullPath).replace(/\\/g, '/'))
                });
            }
        }
        return ret;
    } catch (_) {
        return ret;
    }
});

const resolvePath = function (input) {
    let path = input.replace(/\\/g, '/');
    path = path.replace(/\/?\.\.\/?/g, '/');

    return Path.join(Path.resolve(DATA_PATH), path);
};

server.get(/\/read-dir\/(.*)/, Promise.coroutine(function *(req, res, next) {
    try {
        let fullPath = resolvePath(req.params[0]);
        let files = yield ScanDir('', fullPath, []);
        ResponseSuccess(res, files);
    } catch (ex) {
        DebugLog('push-built failed', ex);
        ResponseError(res, ex);
    }
}));


// READ FILE
server.get(/\/read-file\/(.*)/, Promise.coroutine(function *(req, res, next) {
    try {
        let fullPath = resolvePath(req.params[0]);
        let stat;
        try {
            stat = yield Fs.statAsync(fullPath);
        } catch (ex) {
            console.log('404', fullPath);
            next(new Restify.ResourceNotFoundError('%s does not exist', req.path()));
            return;
        }

        if (!stat.isFile()) {
            next(new Restify.ResourceNotFoundError('%s does not exist', req.path()));
            return;
        }

        var stream = Fs.createReadStream(fullPath, {autoClose: true});

        stream.on('open', function () {
            // console.log('MIME', Mime.lookup(fullPath));
            res.set('Content-Length', stat.size);
            res.set('Content-Type', Mime.lookup(fullPath));
            res.set('Last-Modified', stat.mtime);

            res.writeHead(200);

            stream.pipe(res);
            stream.once('end', function () {
                next(false);
            });
        });

        // res.once('end', function () {
        //     console.log('srv: responding');
        //     res.send(204);
        // });
        // res.on('error', function(error){
        //      console.log(error);
        // })
    } catch (ex) {
        DebugLog('push-built failed', ex);
        ResponseError(res, ex);
    }
}));

// WRITE FILE
server.post(/\/write-file\/(.*)/, Promise.coroutine(function *(req, res, next) {
    try {
        let fullPath = resolvePath(req.params[0]);
        // console.log('fullPath', fullPath);
        let dir = Path.dirname(fullPath);
        yield FsExtra.ensureDirAsync(dir);

        if (req.body) {
            yield Fs.writeFileAsync(fullPath, req.body);
            ResponseSuccess(res, 'ok');
        } else {
            let stream = Fs.createWriteStream(fullPath);
            req.pipe(stream);
            req.on('end', function () {
                ResponseSuccess(res, 'ok');
            });
        }
    } catch (ex) {
        DebugLog('push-built failed', ex);
        ResponseError(res, ex);
    }
}));

server.listen(PORT, HOST, () => {
    console.info(`${server.name} listening at ${server.url}`);
});
