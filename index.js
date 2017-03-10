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
    let env = _.assign({}, process.env, options.env || {});
    options.env = env;
    options.env['NODE_PATH'] = Path.join(__dirname, 'runtime', 'node_modules');

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

const IsRepoExists = Promise.coroutine(function *(repoUrl) {
    let localRepoPath = GetRepoLocalPath(repoUrl);
    let localRepoGitPath = localRepoPath + Path.sep + '.git';
    return (yield IsFolderExists(localRepoPath)) &&
        (yield IsFolderExists(localRepoGitPath));
});

const CloneRepository = Promise.coroutine(function *(repoUrl) {

});

const BuildRepository = Promise.coroutine(function *(repoUrl) {

});

const PushRepository = Promise.coroutine(function *(repoUrl) {

});

const PullRepository = Promise.coroutine(function *(repoUrl) {

});

server.post({
    url: '/init', validation: {
        resources: {
            repoUrl: {isRequired: true, isUrl: true}
        }
    }
}, Promise.coroutine(function*(req, res, next) {
    try {
        let repoUrl = req.params.repoUrl;

        // check if repo exist and valid
        if (yield IsRepoExists(repoUrl))
            return ResponseSuccess(res, 'exists');

        let localRepoDir = GetRepoLocalPath(repoUrl);
        // remove repos url if exists
        try {
            yield FsExtra.removeAsync(localRepoDir);
        } catch (_) {
        }
        // create folder
        yield FsExtra.ensureDirAsync(localRepoDir);
        // git clone
        let ret = yield SpawnGitShell('git', ['clone', '-b', 'master', repoUrl, '.'], {cwd: localRepoDir + Path.sep})
        console.log('git init ret', ret);
        ResponseSuccess(res, 'ok');
    } catch (ex) {
        console.error(ex);
        ResponseError(res, ex);
    }
}));

server.post('/build', (req, res, next) => {
    let input = {
        repoUrl:        '',
        pushAfterBuild: true,
        pushBrach:      'gh-pages'
    };
    // call init repo
    // call build
    // push if pushAfterBuild true
})

server.get('/push', (req, res, next) => {
    let input = {
        repoUrl:   '',
        pushBrach: 'gh-pages'
    };
    // check if repo exist and valid
    // if not return false
    // if valid call push
})

server.listen(config.port, config.host, () => {
    console.info(`${server.name} listening at ${server.url}`);
})
