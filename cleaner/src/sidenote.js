import sourceMapSupport from 'source-map-support';
// @see https://github.com/evanw/node-source-map-support
sourceMapSupport.install();

'use strict';

import 'babel-polyfill';

var co = require('co');

function *sub(val) {
    yield sleep(100, val + '-x1');
    console.log('sub-' + val + '-x1: sleep: ' + val + '-x1');

    yield [sleep(100, val + '-x2'), sleep(200, val + '-x3')];
    console.log('sub-' + val + '-x2: sleep: ' + val + '-x2');

    return val;
}
try {
    a
} catch (e) {
    console.log(e.stack);
}
function sleep(msec, val) {
    return new Promise(function (resolve, reject) {
        setTimeout(resolve, msec, val);
    });
}

var r = co(sub(1));

console.log({r:r, a:sub(1), b:Object.assign({}, {a:1}, {b:2})});