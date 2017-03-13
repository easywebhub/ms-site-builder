'use strict';

const Restify = require('restify');
const RestifyValidation = require('node-restify-validation');
const Promise = require('bluebird');
const Minimist = require('minimist');
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
server.use(Restify.CORS());
server.use(Restify.authorizationParser());
server.use(Restify.queryParser());
server.use(Restify.bodyParser());
server.use(RestifyValidation.validationPlugin({
    errorsAsArray: false,
    errorHandler:  Restify.errors.InvalidArgumentError
}));

server.server.setTimeout(config.timeout, _.noop);

const SpawnGitShell = Promise.coroutine(function *(command, args, options) {
    options = options || {};
    // let env = _.assign({}, process.env);
    // console.log('env', env);
    options.env = process.env;
    options.env['NODE_PATH'] = Path.join(__dirname, 'runtime', 'node_modules');
    let pathKey = options.env['Path'] ? 'Path' : 'PATH';
    options.env[pathKey] = Path.join(__dirname, 'runtime', 'node_modules', '.bin') + ';' + options.env[pathKey];
    options.env['GIT_SSL_NO_VERIFY'] = true; // bug ssl ca store not found
    // console.log(`options.env['PATH'`, options.env['PATH']);
    return yield SpawnShell(command, args, options);
});

const ResponseSuccess = function (res, result) {
    res.json({result: result, error: null});
}

const ResponseError = function (res, error) {
    let errorMsg = typeof(error) === 'string' ? error : error.message ? error.message : error.toString();
    res.json({result: null, error: errorMsg});
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
    return Path.resolve(Path.join(config.dataPath, info.group, info.project));
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
        console.log('RemoveFolder', dir);
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

const InitBuildRepository = Promise.coroutine(function *(repoUrl, localRepoDir) {
    return yield SpawnGitShell('git', ['clone', '-q', '-b', 'gh-pages', repoUrl, 'build'], {cwd: localRepoDir + Path.sep});
});

const CloneOrUpdateRepository = Promise.coroutine(function *(repoUrl, branch, localRepoDir) {
    if (yield IsFolderExists(localRepoDir + Path.sep + '.git')) {
        yield SpawnGitShell('git', ['pull', '-q', '-s', 'recursive', '-Xtheirs'], {cwd: localRepoDir + Path.sep});
    } else {
        yield InitRootRepository(repoUrl, branch, localRepoDir);
        RemoveFolder(localRepoDir + Path.sep + 'build');
        yield InitBuildRepository(repoUrl, branch, localRepoDir);
    }
});

const BuildRepository = Promise.coroutine(function *(localRepoDir) {
    return yield SpawnGitShell('gulp', ['build', '--production'], {cwd: localRepoDir + Path.sep});
});

const PushRepository = Promise.coroutine(function *(repoUrl, remote, branch) {
    remote = remote || 'origin';
    branch = branch || 'gh-pages';

    yield SpawnGitShell('git', ['push', '--force', remote, branch], {cwd: localRepoDir + Path.sep})
});

const PullRepositoryRoot = Promise.coroutine(function *(localRepoDir) {
    return yield SpawnGitShell('git', ['pull'], {cwd: localRepoDir + Path.sep})
});

const PushRepositoryBuild = Promise.coroutine(function *(localRepoDir) {
    let buildDir = Path.join(localRepoDir, 'build');
    yield SpawnGitShell('git', ['checkout', 'gh-pages'], {cwd: buildDir});
    yield SpawnGitShell('git', ['branch', '--set-upstream-to=origin/gh-pages'], {cwd: buildDir});
    yield SpawnGitShell('git', ['pull', 'origin', 'gh-pages', '-s', 'recursive', '-X', 'ours'], {cwd: buildDir});

    // add file
    yield SpawnGitShell('git', ['add', '.'], {cwd: buildDir});
    // commit
    let message = (new Date()).toISOString();
    yield SpawnGitShell('git', ['commit', `-m"${message}"`], {cwd: buildDir});
    // push
    yield SpawnGitShell('git', ['push', 'origin', 'HEAD:gh-pages'], {cwd: buildDir});
});

/**
 * init repository and it's build folder
 */
server.post({
    url: '/init', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function*(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;
        let localRepoDir = GetRepoLocalPath(repoUrl);
        let buildFolder = Path.join(localRepoDir, 'build');

        // check if repo exist and valid
        let isLocaclFolderExists = yield IsFolderExists(localRepoDir);
        let isBuildFolderExists = yield IsFolderExists(buildFolder);
        if (isLocaclFolderExists === true &&  isBuildFolderExists === true) {
            return ResponseSuccess(res, 'exists')
        }

        // remove repos url if exists
        RemoveFolder(localRepoDir);
        // create folder
        try {
            yield FsExtra.ensureDirAsync(localRepoDir + Path.sep);
        } catch(ex) {
            // console.log('ensureDir failed', ex);
        }
        // git clone root
        let ret = yield InitRootRepository(repoUrl, 'master', localRepoDir);
        console.log('git init root folder ret', ret);

        // remove build folder
        RemoveFolder(buildFolder);
        // git clone build folder
        ret = yield InitBuildRepository(repoUrl, localRepoDir);
        console.log('git init build folder ret', ret);
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        console.error(ex);
        ResponseError(res, ex);
    }
}));

/**
 * build
 * push if asked
 */
server.post({
    url: '/build', validation: {
        resources: {
            repoUrl:        {isRequired: true, isUrl: true},
            pushAfterBuild: {isRequired: false, isBoolean: true},
            pushBrach:      {isRequired: false, isAlphanumeric: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    try {
        let localRepoDir = GetRepoLocalPath(req.params.repoUrl);
        let pushAfterBuild = !!(req.params.pushAfterBuild);
        let pushBranch = typeof(req.params.pushBranch) === 'string' ? req.params.pushBranch : '';

        // error if repo not ready
        let rootDotGitFolder = Path.join(localRepoDir, '.git');
        let buildFolder = Path.join(localRepoDir, 'build');
        let buildDotGitFolder = Path.join(localRepoDir, 'build', '.git');
        if (!(yield IsFolderExists(rootDotGitFolder)) || !(yield IsFolderExists(buildDotGitFolder))) {
            return ResponseError(res, 'repository is not initialized');
        }

        // call build
        let ret = yield SpawnGitShell('gulp', ['--no-color', 'build', '--production'], {cwd: localRepoDir});
        let buildSuccess = ret.indexOf(`Finished '`) != -1;
        console.log('build ret', ret);
        if (!buildSuccess) {
            let errorStartIndex = ret.find('Error:');
            if (errorStartIndex === -1)
                return ResponseError(res, ret);
            else {
                console.log('BUILD ERROR', ret.slice(errorStartIndex + 7));
                return ResponseError(res, ret.slice(errorStartIndex + 7));
            }
        }
        console.log('buildSuccess', buildSuccess);
        // check if push requested
        if (!pushAfterBuild || pushBranch === '')
            return ResponseSuccess(res, 'ok');
        // push
        ret = yield PushRepositoryBuild(localRepoDir);
        console.log('push ret', ret);
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        // trim color code from error log
        ex = ex.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        ResponseError(res, ex);
    }
}));


server.get({
    url: '/push', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function *(req, res, next) {
    let input = {
        repoUrl:   '',
        pushBrach: 'gh-pages'
    };

    try {
        let localRepoDir = GetRepoLocalPath(req.params.repoUrl);
        yield PushRepositoryBuild(localRepoDir);
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        console.log('push failed', ex);
        ResponseError(res, ex);
    }
}));

server.listen(config.port, config.host, () => {
    console.info(`${server.name} listening at ${server.url}`);
})
