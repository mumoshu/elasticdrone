import co from 'co';

export class Credentials {
    constructor({s3, bucketName}) {
        this.s3 = s3;
        this.bucketName = bucketName;
    }
    fetchSshPrivateKey() {
        return this.fetchObject('global/ssh_private_key.pem');
    }
    fetchCredentials(id) {
        let self = this;

        console.log(`Fetching credentials for docker connection.`);

        return co(function*() {
            let [cert, key, ca] = yield Promise.all([
                self.fetchDockerCert(id),
                self.fetchDockerKey(id),
                self.fetchDockerCa(id)
            ]);

            console.log(`Successfully obtained credentials for docker connection.`);

            return {cert, key, ca};
        });
    }
    fetchDockerCert(privateIpAddress) {
        return this.fetchObject('nodes/' + privateIpAddress + '/cert.pem');
    }
    fetchDockerKey(privateIpAddress) {
        return this.fetchObject('nodes/' + privateIpAddress + '/key.pem');
    }
    fetchDockerCa(privateIpAddress) {
        return this.fetchObject('nodes/' + privateIpAddress + '/ca.pem');
    }
    fetchObject(key) {
        console.log(`Fetching the S3 object for the key ${key} in the bucket ${this.bucketName}`);
        return this.s3.getObjectAsync({Key: key, Bucket: this.bucketName}).then((response) => response.Body.toString());
    }
};
