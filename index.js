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
const CONFIG_FILE = argv.config || './config.js';
const AppInfo = JSON.parse(Fs.readFileSync('package.json'));

process.on('uncaughtException', (err) => {
    console.warn('uncaughtException', err);
})

function DebugLog() {
    if (!DEBUG) return;
    console.log.apply(console, arguments);
}

let config;
try {
    config = require(CONFIG_FILE);
} catch (error) {
    console.error('load config failed', error.message);
    process.exit(1);
}

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

server.server.setTimeout(config.timeout, _.noop);

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
    return Path.resolve(Path.join(config.dataPath, info.group, info.project)) + Path.sep;
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
    return yield SpawnGitShell('git', ['clone', '-q', '-b', branch, repoUrl, '.'], {cwd: localRepoDir + Path.sep});
});


// const CloneOrUpdateRepository = Promise.coroutine(function *(repoUrl, branch, localRepoDir) {
//     if (yield IsFolderExists(localRepoDir + Path.sep + '.git')) {
//         yield SpawnGitShell('git', ['pull', '-q', '-s', 'recursive', '-Xtheirs'], {cwd: localRepoDir + Path.sep});
//     } else {
//         yield InitRootRepository(repoUrl, branch, localRepoDir);
//         RemoveFolder(localRepoDir + Path.sep + 'build');
//         yield InitBuildRepository(repoUrl, branch, localRepoDir);
//     }
// });

// const BuildRepository = Promise.coroutine(function *(localRepoDir) {
//     let gulpPath = Path.join(__dirname, 'runtime', 'node_modules', '.bin', 'gulp');
//     return yield SpawnGitShell(gulpPath, ['build', '--production'], {cwd: localRepoDir + Path.sep});
// });

// const PushRepository = Promise.coroutine(function *(repoUrl, remote, branch) {
//     remote = remote || 'origin';
//     branch = branch || 'gh-pages';
//
//     yield SpawnGitShell('git', ['push', '--force', remote, branch], {cwd: localRepoDir + Path.sep})
// });

// const PullRepositoryRoot = Promise.coroutine(function *(localRepoDir) {
//     if (!workDir.endsWith(Path.sep)) workDir += Path.sep;
//     DebugLog(yield SpawnGitShell('git', ['fetch', '--all'], {cwd: localRepoDir + Path.sep}));
//     return yield SpawnGitShell('git', ['reset', '--hard', 'origin/master'], {cwd: localRepoDir + Path.sep})
// });


// const PushRepositoryBuild = Promise.coroutine(function *(localRepoDir) {
//     let buildDir = Path.join(localRepoDir, 'build');
//     DebugLog(yield SpawnGitShell('git', ['checkout', 'gh-pages'], {cwd: buildDir}));
//     DebugLog(yield SpawnGitShell('git', ['branch', '--set-upstream-to=origin/gh-pages'], {cwd: buildDir}));
//     DebugLog(yield SpawnGitShell('git', ['pull', 'origin', 'gh-pages', '-s', 'recursive', '-X', 'ours'], {cwd: buildDir}));
//
//     // add file
//     DebugLog(yield SpawnGitShell('git', ['add', '.'], {cwd: buildDir}));
//     // commit
//     // try {
//     let message = Moment().format('YYYY-MM-DD HH:mm:ss');
//     DebugLog(yield SpawnGitShell('git', ['commit', `-m"${message}"`], {cwd: buildDir}));
//     // } catch (ex) {
//     //     console.log('PushRepositoryBuild exception', ex);
//     // }
//     // push
//     return yield SpawnGitShell('git', ['push', 'origin', 'HEAD:gh-pages'], {cwd: buildDir});
// });
//
// /**
//  * build
//  * push if asked
//  */
// server.post({
//     url: '/build', validation: {
//         resources: {
//             repoUrl:        {isRequired: true, isUrl: true},
//             pushAfterBuild: {isRequired: false},
//             pushBranch:     {isRequired: false, isRegex: /[a-zA-Z0-9\-_]/}
//         }
//     }
// }, Promise.coroutine(function *(req, res, next) {
//     try {
//         let localRepoDir = GetRepoLocalPath(req.params.repoUrl);
//         let pushAfterBuild = req.params.pushAfterBuild;
//         if (pushAfterBuild !== true && pushAfterBuild !== false) {
//             return ResponseError(res, 'pushAfterBuild (INVALID): Invalid boolean');
//         }
//         let pushBranch = typeof(req.params.pushBranch) === 'string' ? req.params.pushBranch : 'gh-pages';
//
//         DebugLog('Start handle "build" request, url', req.params.repoUrl, 'pushAfterBuild', pushAfterBuild, 'pushBranch', pushBranch);
//
//         // error if repo not ready
//         let rootDotGitFolder = Path.join(localRepoDir, '.git');
//         let buildFolder = Path.join(localRepoDir, 'build');
//         let buildDotGitFolder = Path.join(localRepoDir, 'build', '.git');
//         if (!(yield IsFolderExists(rootDotGitFolder)) || !(yield IsFolderExists(buildDotGitFolder))) {
//             return ResponseError(res, 'repository is not initialized');
//         }
//
//         // pull update
//         let ret = yield PullRepositoryRoot(localRepoDir);
//         DebugLog(ret);
//
//         // call build
//         let gulpPath = Path.join(__dirname, 'runtime', 'node_modules', '.bin', 'gulp');
//         ret = yield SpawnGitShell(gulpPath, ['--no-color', 'build', '--production'], {cwd: localRepoDir});
//         let buildSuccess = ret.indexOf(`Finished '`) != -1;
//         DebugLog('build ret', ret);
//         if (!buildSuccess) {
//             let errorStartIndex = ret.find('Error:');
//             if (errorStartIndex === -1) {
//                 return ResponseError(res, ret);
//             } else {
//                 DebugLog('BUILD ERROR', ret.slice(errorStartIndex + 7));
//                 return ResponseError(res, ret.slice(errorStartIndex + 7));
//             }
//         }
//         // check if push requested
//         if (!pushAfterBuild || pushBranch === '')
//             return ResponseSuccess(res, 'ok');
//         // push
//         ret = yield PushRepositoryBuild(localRepoDir);
//         DebugLog('push ret', ret);
//         ResponseSuccess(res, 'ok');
//     } catch (ex) {
//         ex = ex.toString();
//         if (typeof(ex) === 'string' && ex.indexOf('working tree clean') !== -1)
//             return ResponseSuccess(res, 'ok');
//         // trim color code from error log
//         ex = ex.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
//         ResponseError(res, ex);
//     }
// }));


// server.post({
//     url: '/push', validation: {
//         resources: {
//             repoUrl:    {isRequired: true, isUrl: true},
//             pushBranch: {isRequired: true, isRegex: /[a-zA-Z0-9\-_]/}
//         }
//     }
// }, Promise.coroutine(function *(req, res, next) {
//     try {
//         let localRepoDir = GetRepoLocalPath(req.params.repoUrl);
//         let branch = req.params.pushBranch;
//         DebugLog('Start handle "push" request, url', req.params.repoUrl, 'pushBranch', req.params.pushBranch);
//
//         let rootDotGitFolder = Path.join(localRepoDir, '.git');
//         let buildDotGitFolder = Path.join(localRepoDir, 'build', '.git');
//         if (!(yield IsFolderExists(rootDotGitFolder)) || !(yield IsFolderExists(buildDotGitFolder))) {
//             return ResponseError(res, 'repository is not initialized');
//         }
//
//         let ret = yield PushRepositoryBuild(localRepoDir);
//         DebugLog('push build result', ret);
//         ResponseSuccess(res, 'ok');
//     } catch (ex) {
//         if (typeof(ex) === 'string' && ex.indexOf('working tree clean') !== -1)
//             return ResponseSuccess(res, 'ok');
//         DebugLog('push failed', ex);
//         ResponseError(res, ex);
//     }
// }));

// NEW CODE START
const InitBuildRepository = Promise.coroutine(function *(repoUrl, localRepoDir) {
    return yield SpawnGitShell('git', ['clone', '-q', '-b', 'gh-pages', repoUrl, 'build'], {cwd: localRepoDir + Path.sep});
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

const BuildSrc = Promise.coroutine(function *(workDir) {
    if (!workDir.endsWith(Path.sep)) workDir += Path.sep;
    let gulpPath = Path.join(__dirname, 'runtime', 'node_modules', '.bin', 'gulp');
    let ret = yield SpawnGitShell(gulpPath, ['--no-color', 'build', '--production'], {cwd: workDir});
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
            return ResponseSuccess(res, 'exists')
        }

        // remove repos url if exists
        RemoveFolder(localRepoDir);
        // create folder
        try {
            yield FsExtra.ensureDirAsync(localRepoDir + Path.sep);
        } catch (ex) {
        }
        // git clone root
        let ret = yield InitRootRepository(repoUrl, 'master', localRepoDir);
        DebugLog('git init root folder ret', ret);

        // remove build folder
        RemoveFolder(buildFolder);
        // git clone build folder
        ret = yield InitBuildRepository(repoUrl, localRepoDir);
        DebugLog('git init build folder ret', ret);
        ResponseSuccess(res, 'ok');
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
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let localRepoDir = GetRepoLocalPath(repoUrl);
        DebugLog(yield BuildSrc(localRepoDir));
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

    return Path.join(Path.resolve(config.dataPath), path);
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

server.listen(config.port, config.host, () => {
    console.info(`${server.name} listening at ${server.url}`);
});
