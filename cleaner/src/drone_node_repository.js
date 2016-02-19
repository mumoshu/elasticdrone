export class DroneNodeRepository {
    constructor({droneClient}) {
        this.droneClient = droneClient;
    }

    createNode(data) {
        let nodeParams = {
            id: 0,
            address: 'tcp://' + data.privateIpAddress + ':2376',
            cert: data.cert,
            architecture: 'linux_amd64',
            key: data.key,
            ca: data.ca
        };

        console.log(nodeParams);
        console.log(JSON.stringify(nodeParams));

        return this.droneClient._request('post', '/api/nodes', {
            payload: JSON.stringify(nodeParams),
            headers: {'Content-Type': 'application/json'}
        });
    }

    fetchNodes() {
        return this.droneClient.getNodes();
    }

    deleteNodeById(id) {
        return this.droneClient.deleteNode(id)
    }
}
