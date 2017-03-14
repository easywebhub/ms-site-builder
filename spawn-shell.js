"use strict";

const BlueBird = require("bluebird");
const ChildProcess = require("child_process");

module.exports = (command, args, options = {}) => {
    options.shell = true;
    let stdout = '';
    let stderr = '';
    options.env = options.env || {};
    options.env.GIT_SSL_NO_VERIFY = true;
    return new BlueBird((resolve, reject) => {
        let process = ChildProcess.spawn(command, args, options);
        process.on('error', err => {
            reject(err);
        });
        process.stdout.on('data', data => {
            stdout += `${data}`.trim();
        });
        process.stderr.on('data', data => {
            stderr += `${data}`.trim();
        });
        process.on('close', (code) => {
            if (code === 0) {
                resolve(stdout + stderr);
            } else {
                reject(stdout + stderr);
            }
        });
    });
};
