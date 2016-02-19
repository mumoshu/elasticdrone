import { Client } from 'ssh2';
import Promise from 'bluebird';

export class RemoteShell {
    constructor(conn) {
        this.conn = conn;
    }

    capture(command) {
        var conn = this.conn;

        return new Promise(function (resolve, reject) {
            conn.exec(command, function(err, stream) {
                var result = '';

                if (err) throw err;
                stream.on('close', function(code, signal) {
                    console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
                    console.log(result);
                    resolve(result);
                    //conn.end();
                }).on('data', function(data) {
                    console.log('STDOUT: ' + data);
                    result += data;
                }).stderr.on('data', function(data) {
                    console.log('STDERR: ' + data);
                });
            });
        });
    }

    disconnect() {
        this.conn.end();
    }

    static connect(connection) {
        return new Promise(function (resolve, reject) {
            var conn = new Client();
            conn.on('ready', function() {
                console.log('Client :: ready');
                resolve(new RemoteShell(conn));
            }).connect(connection);
        });
    }
}
