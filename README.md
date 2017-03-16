# ms-site-builder
Microservice build metalsmith website

### Config
```json
    "host":     "127.0.0.1",
    "port":     8002,
    "timeout":  300000, // service response max timeout
    "dataPath": "repositories" // local repositories path
```

### Install
* clone this repository
* run `npm install` in root and `npm install` in `runtime` folder

### Run
* `node index.js`
* DEBUG mode `node index.js --debug`

### API

#### init `POST` `/init` data
```json
{"repoUrl": "https://qq:d65f1c188efa497d2e9d28f1ea83b42625b574b1ec7e98b02db1404a9882faf2@source.easywebhub.com/qq/demo-deploy-github.git"}
```
##### Init internal
* git clone master branch to `${dataPath}/qq/demo-deploy-github`
* git clone gh-pages branch to build folder `${dataPath}/qq/demo-deploy-github/build`

#### build `POST` `/build` data
```json
{
    "repoUrl": "https://qq:d65f1c188efa497d2e9d28f1ea83b42625b574b1ec7e98b02db1404a9882faf2@source.easywebhub.com/qq/demo-deploy-github.git",
    "pushAfterBuild": false,
    "pushBranch": "gh-pages"
}
```
##### Build internal
* fetch remote repository
* reset hard all local changes
* build gulp --production
* push build folder to remote

#### push `POST` `/push` data
```json
{
    "repoUrl": "https://qq:d65f1c188efa497d2e9d28f1ea83b42625b574b1ec7e98b02db1404a9882faf2@source.easywebhub.com/qq/demo-deploy-github.git",
    "pushBranch": "gh-pages"
}
```
