# ms-site-builder
Microservice build metalsmith website

## I. How to run ms-site-builder on Linux Server

### 1. Install
* clone this repository
* run `npm install` in root and `npm install` in `runtime` folder

### 2. Config
```json
/config.js
{
    "host":     "127.0.0.1",
    "port":     8002,
    "timeout":  300000, // service response max timeout
    "dataPath": "repositories" // local repositories path
}
```

### Run
* `node index.js`
* DEBUG mode `node index.js --debug`

### API for websites built on ms-site-builder
> endpoint: `host:port` on config.js

>> {sourceWebsite} : "https://{username}:{pass}@source.easywebhub.com/{username}/{website-name}.git"
>> Ví dụ: "https://qq:d65f1c188efa497d2e9d28f1ea83b42625b574b1ec7e98b02db1404a9882faf2@source.easywebhub.com/qq/demo-deploy-github.git"

#### Call `POST /init ` to init a new website

```json
{
"repoUrl": "{sourceWebsite}"
}
```
##### Init internal
* git clone master branch to `${dataPath}/qq/demo-deploy-github`
* git clone gh-pages branch to build folder `${dataPath}/qq/demo-deploy-github/build`

#### Call API `POST` `/build` to build on server
```json
{
    "repoUrl": "{sourceWebsite}"
}
```

#### call API `POST` `/push-src` to push src to remote `master` branch
```json
{
    "repoUrl": "{sourceWebsite}"
}
```

#### call API `POST` `/push-built` to push `build` folder remote
```json
{
    "repoUrl": "{sourceWebsite}",
    "pushBranch": "{remoteBranch}" // default to gh-pages
}
```

#### get file list in a directory `GET` `/read-dir/:dir` e.g.
`http://127.0.0.1:8002/read-dir/qq/demo-deploy-github`
##### response
```json
{
  "result": [
    {
      "name": "COMMIT_EDITMSG",
      "path": "repositories/qq/demo-deploy-github/.git/COMMIT_EDITMSG"
    },
    {
      "name": "config",
      "path": "repositories/qq/demo-deploy-github/.git/config"
    }
}
```

#### read file `GET` `/read-dir/:filePath` e.g.
`http://127.0.0.1:8002/read-file/qq/demo-deploy-github/content/data-files.md`
##### whole request response is file data

#### write file `POST` `/write-file/:filePath` post data is file content
`http://127.0.0.1:8002/read-file/qq/demo-deploy-github/content/data-files.md`
##### response
```json
{ "result": "ok" }
```

#### Actions

- push source
- pull source
   - "fetch remote repository"
   - 2.reset hard all local changes 
- build source 
   - 3. build gulp --production

- push  website

- build & push website
- pull source & build & push website
- push source & build & push website

- list all Content (.md | .json) from source  
- getFileContent(string filePath, string website-name) 
   
- AddOrEditFile(.md | .json)
