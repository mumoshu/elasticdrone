var sourceMapSupport = require('source-map-support');
// @see https://github.com/evanw/node-source-map-support
sourceMapSupport.install();

import 'babel-polyfill';

const co = require('co');
const moment = require('moment');

const AWS = require('aws-sdk');
const Docker = require('dockerode');
const Drone = require('drone-node');
const Promise = require('bluebird');

import { RemoteShell } from './remote_shell';
import { Credentials } from './credentials';
import { DroneNodeRepository } from './drone_node_repository';

const DEFAULT_SSH_USERNAME = 'ec2-user';

function requireEnvironmentVariable(name) {
    var value = process.env[name];

    if (typeof value === 'undefined' || value === '') {
        throw `Missing environment variable: ${name}`;
    }

    return value;
}

function communicateThroughPrivateNetwork() {
    return process.env['PRIVATE_MODE'];
}

function connectableIp(instance) {
    return communicateThroughPrivateNetwork() ? instance.PrivateIpAddress : instance.PublicIpAddress;
}

// You must have 3 environment variables set in order to run this script locally.
// export STACK_NAME="The name of Cfn stack"
// export DRONE_TOKEN="The API token you can view in Drone's Profile page."
// export AWS_PROFILE="The name of your AWS profile" // or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
const environment = {
    droneServer: process.env['DRONE_SERVER'], // http(s)://example.com
    droneToken: process.env['DRONE_TOKEN'],
    stackName: requireEnvironmentVariable('STACK_NAME'), // droneci
    awsRegion: process.env['AWS_DEFAULT_REGION'] || 'ap-northeast-1',
    sshUsername: process.env['SSH_USERNAME'] || DEFAULT_SSH_USERNAME
};

const {awsRegion, stackName} = environment;
const cloudformation = new Promise.promisifyAll(new AWS.CloudFormation({region: awsRegion}));
const s3 = Promise.promisifyAll(new AWS.S3());
const autoScaling = Promise.promisifyAll(new AWS.AutoScaling({region: awsRegion}));
const ec2 = Promise.promisifyAll(new AWS.EC2({region: awsRegion}));

// See https://github.com/apocas/dockerode/issues/154
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

console.log({environment: environment});

var App = function ({credentials}) {
    this.credentials = credentials;
};

App.prototype._takeSnapshotThenWait = function (params) {
    var self = this;

    return ec2.createSnapshotAsync(params).then(function checkForStateToRetry(data) {
        var snapshotId = data.SnapshotId;
        var volumeId = data.VolumeId;
        var state = data.State;
        console.log(data);
        return Promise.delay(5000).then(function () {
            return ec2.describeSnapshotsAsync({"SnapshotIds": [snapshotId]}).then(function loop(snapshots) {
                console.log("Fetched " + snapshots.Snapshots.length + " snapshots");
                var snapshot = snapshots.Snapshots.find(function (s) { return s.SnapshotId === snapshotId; });
                var currentState = snapshot.State;
                self.log("Waiting for the snapshot" + snapshotId + " to complete. Current state is: " + currentState);
                switch (currentState) {
                    case 'error':
                        throw 'Error while waiting for the snapshot to complete.';
                        break;
                    case 'completed':
                        return snapshot;
                        break;
                    default:
                        return checkForStateToRetry(snapshot);
                }
            });
        });
    });
};

App.prototype._waitForNodeToBeFree = function(instance) {
    return Promise.delay(1000);
};

App.prototype._snapshotThenUpdateStackThenTerminate = function(instance) {
    let self = this;

    function *unmountVolume(instance) {
        let sshPrivateKey = yield self.credentials.fetchSshPrivateKey();

        let shell = yield RemoteShell.connect({
            host: connectableIp(instance),
            port: 22,
            username: environment.sshUsername,
            privateKey: sshPrivateKey
        });

        yield shell.capture('sudo umount -d /var/lib/drone');

        shell.disconnect();

        let blockDeviceMappings = instance.BlockDeviceMappings;
        let droneWorkerCacheVolume = blockDeviceMappings.find(function (dev) {
            // TODO We should fetch this from the cfn stack
            return dev.DeviceName === '/dev/sdk';
        });
        let volumeId = droneWorkerCacheVolume.Ebs.VolumeId;

        return volumeId;
    }

    function *takeSnapshot(volumeId) {
        // See http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/EC2.html#createSnapshot-property
        return self._takeSnapshotThenWait({VolumeId: volumeId, Description: "DroneWorkerCache"});
    }

    function *terminate(instance) {
        let instanceId = instance.InstanceId;
        console.log("Snapshot taken. Terminating: " + instanceId);
        return ec2.terminateInstancesAsync({InstanceIds: [instanceId]})
    }

    function *updateStack(snapshot) {
        var snapshotId = snapshot.SnapshotId;
        console.log("Updating the cloudformation stack with the snapshot: " + snapshotId);
        var params = {
            StackName: stackName,
            Capabilities: [
                'CAPABILITY_IAM'
            ],
            UsePreviousTemplate: true,
            Parameters: [
                {
                    ParameterKey: 'DroneRemoteDriver',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneRemoteConfig',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'VPC',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'Subnets',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'KeyName',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerMaxCapacity',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerMultiplicity',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerScaleOutThresholdCPU',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerScaleOutThresholdMinutes',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerScaleInThresholdCPU',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerScaleInThresholdMinutes',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerCacheCapacityInGB',
                    UsePreviousValue: true
                },
                {
                    ParameterKey: 'DroneWorkerCacheSnapshotId',
                    ParameterValue: snapshotId
                },
                {
                    ParameterKey: 'IncomingYourRequestCidr',
                    UsePreviousValue: true
                },
            ]
        };

        yield cloudformation.updateStackAsync(params);

        var params = { StackName: stackName };
        var current = yield cloudformation.describeStacksAsync(params);
        while (current.Stacks[0].StackStatus === 'UPDATE_IN_PROGRESS') {
            console.log("Waiting for the cfn stack to be updated: " + current.Stacks[0].StackStatus);
            current = yield cloudformation.describeStacksAsync(params);
            yield Promise.delay(5000);
        }
    }

    return co(function*() {
        let volumeId = yield unmountVolume(instance);
        let snapshot = yield takeSnapshot(volumeId);

        yield terminate(instance);

        return updateStack(snapshot);
    });
};

App.prototype._terminate = function(instance) {
    var self = this;
    var instanceId = instance.InstanceId;

    console.log("Terminating: " + instanceId);
    return ec2.terminateInstancesAsync({InstanceIds: [instanceId]});
};

App.prototype.log = function (any) {
    console.log(any);
    return any;
}

function getEC2InstancesForASG(autoscalingGroupName) {
    return co(function*() {
        let r = yield autoScaling.describeAutoScalingGroupsAsync({AutoScalingGroupNames: [autoscalingGroupName]});

        var instanceIds = r.AutoScalingGroups[0].Instances.map(function(instance) { return instance.InstanceId; });
        console.log({ServerInstanceIds:instanceIds});

        let r2 = yield ec2.describeInstancesAsync({InstanceIds: instanceIds});

        var instances = Array.prototype.concat.apply([], r2.Reservations.map(function (r) { return r.Instances }));

        return instances;
    });
}

function handler(event, context) {
    let fetchDynamicConfiguration = function*() {
        let result = yield cloudformation.describeStacksAsync({StackName: stackName});
        console.log(result);
        let stack = result.Stacks[0];
        let outputs = {};
        for (let {OutputKey, OutputValue} of stack.Outputs) {
            console.log(`${OutputKey}=${OutputValue}`);
            outputs[OutputKey] = OutputValue;
        }

        function fetchDroneToken() {
            return s3.getObjectAsync({Key: 'roles/worker/env/DRONE_TOKEN', Bucket: outputs.BucketName}).then((response) => response.Body.toString());
        }

        let droneToken;

        if (environment.droneToken) {
            droneToken = environment.droneToken;
        } else {
            droneToken = yield fetchDroneToken();
        }

        let configuration = {
            droneToken,
            autoscalingGroupName: outputs.WorkerAutoScalingGroup,
            serverAutoscalingGroupName: outputs.MasterAutoScalingGroup,
            bucketName: outputs.BucketName,
            droneServer: outputs.DroneServer
        };
        return configuration;
    };

    return co(function*() {
      let configuration = yield fetchDynamicConfiguration;
      let credentials = new Credentials({s3, bucketName: configuration.bucketName});
      let droneServer = yield co(function *() {
          if (communicateThroughPrivateNetwork()) {
              var serverInstances = yield getEC2InstancesForASG(configuration.serverAutoscalingGroupName);
              var serverInstance = serverInstances[0];
              return `http://${serverInstance.PrivateIpAddress}`;
          } else {
              return environment.droneServer || configuration.droneServer;
          }
      });
      let droneClient = new Drone.Client({
            url: droneServer,
            token: configuration.droneToken
      });
      let droneNodeRepository = new DroneNodeRepository({droneClient});
      let services = {
          credentials,
          droneNodeRepository,
          app: new App({credentials, droneNodeRepository})
      };
      console.log({configuration: configuration});
      let result = yield run({configuration, services});
      context.succeed(result);
    }).catch(function (e) {
      console.log("Error: " + e + "\n" + e.stack);
    });
}

function *run({configuration, services}) {
    let {autoscalingGroupName, serverAutoscalingGroupName, bucketName} = configuration;
    let {credentials, app, droneNodeRepository} = services;

    let getNodes = co(function*() {
        let nodes = yield droneNodeRepository.fetchNodes();

        for (var i=0; i<nodes.length; i++) {
            let addr = nodes[i].address;

            if (addr.indexOf('tcp://') == 0) {
                nodes[i].privateIpAddress = addr.replace(/tcp:\/\/([0-9\.]+):.*$/, '\$1')
            } else {
                delete nodes[i];
            }
        }

        /**
         * { id: 26,
         *   address: 'tcp://10.2.2.5:2376',
         *   architecture: 'linux_amd64',
         *   privateIpAddress: '10.2.2.5',
         *   cert: "*snip*",
         *   key: "*snip*",
         *   ca: "*snip*" }
         */
        nodes = nodes.filter(function (n) { return n });

        let result = yield Promise.all(
            nodes.map((node) =>
                credentials.fetchCredentials(node.privateIpAddress).then((creds) =>
                    Object.assign({}, node, creds)
                )
            )
        );

        console.log(result);

        return result
    });

    let getWorkerInstances = co(function*() {
        console.log(`Listing EC2 instances in the asg: ${autoscalingGroupName}`);
        let r = yield autoScaling.describeAutoScalingGroupsAsync({AutoScalingGroupNames: [autoscalingGroupName]});


        var instanceIds = r.AutoScalingGroups[0].Instances.map(function(instance) { return instance.InstanceId; });

        if (instanceIds.length === 0) {
            throw `No EC2 instances(=drone nodes) found in the autoscaling group: ${autoscalingGroupName}.`
        }

        console.log(`Drone nodes are running at EC2 instances with ids: ${instanceIds.join(', ')}`);

        let r2 = yield ec2.describeInstancesAsync({InstanceIds: instanceIds});

        let instances = Array.prototype.concat.apply([], r2.Reservations.map((r) => r.Instances));

        console.log(`Fetched detailed information of the EC2 instances with ids: ${instanceIds.join(', ')}`);

        return instances;
    });

    let [nodes, instances] = yield Promise.all([getNodes, getWorkerInstances]);

    console.log(`Fetched ${nodes.length} nodes and ${instances.length} instances.`);

    let enrichInstances = instances.map(function (instance) {
        return co(function*() {
            let myNodes = nodes.filter(function (node) { return node.privateIpAddress == instance.PrivateIpAddress; });

            console.log(`Nodes for ${instance.InstanceId}: ${JSON.stringify(myNodes)}`);

            // FIXME
            var node = instance.node = myNodes[0];
            instance.nodes = myNodes;

            var dockerClient = Promise.promisifyAll(new Docker({
                protocol: 'https',
                host: connectableIp(instance),
                port: 2376,
                ca: node.ca,
                cert: node.cert,
                key: node.key
            }));

            var since = moment().subtract(1, 'hour');
            var sinceUtcUnix = since.utc().unix();
            var until = moment();
            var untilUtcUnix = until.unix();

            console.log({since: since, sinceUtcUnix: sinceUtcUnix, until: until, untilUtcUnix: untilUtcUnix});

            var listContainers = dockerClient.listContainersAsync();
            var getEvents = new Promise(function (resolve, reject) {
                dockerClient.getEvents({until: untilUtcUnix, since: sinceUtcUnix, filters: JSON.stringify({event:['create', 'start', 'kill', 'die', 'destroy']})}, function (err, req) {
                    console.log({stream: req});
                    if (err) {
                        console.log({err: err});
                        reject(err);
                    } else {
                        var events = [];
                        req.on('data', function (chunk) {
                            var e = JSON.parse(chunk);
                            events.push(e);
                        });
                        req.on('end', function () {
                            console.log('end');
                            resolve(events);
                        });
                        console.log("waiting for stream");
                    }
                });
            });

            let [containers, events] = yield Promise.all([listContainers, getEvents]);

            var jobs = {};
            events.filter(function(event) {
                return event.from && event.from.indexOf('drone') > 0;
            }).forEach(function (event) {
                jobs[event.id] = jobs[event.id] || {changes: []};
                var job = jobs[event.id];
                job.id = event.id;
                job.changes.push({status: event.status, time: event.time});

                if (event.from) {
                    job.from = event.from;
                }

                // FIXME
                if (typeof job.startedTime === 'undefined') {
                    job.startedTime = event.time;
                } else {
                    job.startedTime = Math.min(job.startedTime, event.time);
                }

                // FIXME
                if (typeof job.finishedTime === 'undefined') {
                    job.finishedTime = event.time;
                } else {
                    job.finishedTime = Math.max(job.finishedTime, event.time);
                }
            });

            var keys = Object.keys(jobs);

            keys.forEach(function (key) {
                var job = jobs[key];
                job.elapsedTime = job.finishedTime - job.startedTime;
            });

            var firstEventTime = Math.min.apply(Math, keys.map(function (key) { return jobs[key].startedTime; }));
            var busyTime = keys.map(function (key) { return jobs[key].elapsedTime; }).reduce(function (a, b) { return a + b; }, 0);

            var result = Object.assign({containers: containers, events: events, jobs: jobs, busyTime: busyTime, firstEventTime: firstEventTime}, instance);

            console.log(require('util').inspect({
                "result": result,
            }, true, 10));

            return result;
        });
    });

    let enrichedInstances = yield Promise.all(enrichInstances);

    // See http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/AutoScaling.html#detachInstances-property
    let instanceIds = enrichedInstances.map(function (instance) { return instance.InstanceId; });
    let detachInstances = co(function*() {
        function fetchNumInstancesInASG(autoscalingGroupName) {
            return autoScaling.describeAutoScalingGroupsAsync({AutoScalingGroupNames: [autoscalingGroupName]})
                .then((result) => result.AutoScalingGroups[0].Instances.length);
        }

        console.log("Detaching instances " + instanceIds.join(", "));

        yield autoScaling.detachInstancesAsync({InstanceIds: instanceIds, AutoScalingGroupName: autoscalingGroupName, ShouldDecrementDesiredCapacity: true});

        var numInstances = yield fetchNumInstancesInASG(autoscalingGroupName);
        while (numInstances > 0) {
            yield Promise.delay(5000);
            console.log("Waiting for " + numInstances + " instances to be detached.");
            numInstances = yield fetchNumInstancesInASG(autoscalingGroupName);
        }
    });

    let allNodes = Array.prototype.concat.apply([], enrichedInstances.map(function (instance) { return instance.nodes; }));

    let deleteNodes = Promise.all(
        allNodes.map((node) => droneNodeRepository.deleteNodeById(node.id))
    );

    yield deleteNodes;

    let restartDrone = co(function*() {
        var serverInstances = yield getEC2InstancesForASG(serverAutoscalingGroupName);
        var serverInstance = serverInstances[0];

        var sshPrivateKey = yield credentials.fetchSshPrivateKey();

        var shell = yield RemoteShell.connect({
            host: connectableIp(serverInstance),
            port: 22,
            username: environment.sshUsername,
            privateKey: sshPrivateKey
        });

        var r1 = yield shell.capture('docker ps');
        var r2 = yield shell.capture('docker ps --format "{{.Image}} {{.ID}}" | grep drone/drone');
        var r3 = yield shell.capture('docker restart ' + r2.split(" ")[1]);

        shell.disconnect();
    });

    yield Promise.all([restartDrone, detachInstances]);

    var tasks = [];

    tasks.push(app._snapshotThenUpdateStackThenTerminate(enrichedInstances[0]));

    if (enrichedInstances.length > 1) {
        for (var i=1; i<enrichedInstances.length; i++) {
            tasks.push(app._terminate(enrichedInstances[i]));
        }
    }

    return Promise.all(tasks);
}

exports.handler = handler;

//if (process.env['LOCAL_RUN'] !== '') {
    var event = {};
    var context = {
        succeed: function (message) {
            console.log({"succeed": message});
        }
    };
    handler(event, context);
//}
