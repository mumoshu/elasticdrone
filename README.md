# Elasticdrone

Elasticdrone is a set of tools to configure an auto-scaled [Drone](https://github.com/drone/drone) cluster on AWS in ease.

## Setup

```
$ cat .envrc
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export VPC_ID=...
export SUBNET1=...
export SUBNET2=...
export ALLOWED_CIDR=e.g. YOUR_IP/32
export KEYNAME=...
export STACK_NAME=droneci
export AWS_PROFILE=...
export SSH_PRIVATE_KEY=<path/to/your/private key to SSH into EC2 instances>

$ direnv allow .

$ ./manual_ops.sh create_stack

$ echo export DRONE_SERVER=http://droneci-LadBalanc-xxxxx.elb.amazonaws.com >> .envrc
$ echo export DRONE_TOKEN=<your token which can be found at your profile page in Drone's Web UI> >> .envrc
$ direnv allow .

$ ./manual_ops.sh update_stack

$ ./manual_ops.sh worker_set_drone_token $DRONE_TOKEN
$ ./manual_ops.sh worker_set_drone_server
$ ./manual_ops.sh worker_upload_scripts
$ ./manual_ops.sh global_upload_ssh_private_key
$ ./manual_ops.sh worker_scale 1
```

Finally, go to AWS console and add an event source mapping to the lambda function which brings down Drone workers at night:

## Specification

* EBS snapshots are taken on shutting down EC2 instances and reused for next launch for the purpose of caching:
  * /var/lib/docker to reduce time taken to run `docker pull`
  * [/var/lib/drone/cache](http://readme.drone.io/usage/caching/#distributed-cache:ac010da762d8cf87ef4765b457c06928) to reduce time taken to rebuild drone's cache for each repo/branch/worker.

## Self-study(How you can bring up your own auto-scaled drone cluster in manual steps)

Modifiy the `/etc/sysconfig/docker` file to contain:

```
# The max number of open files for the daemon itself, and all
# running containers.  The default value of 1048576 mirrors the value
# used by the systemd service unit.
DAEMON_MAXFILES=1048576

# Additional startup options for the Docker daemon, for example:
# OPTIONS="--ip-forward=true --iptables=true"
# By default we limit the number of open files per container
OPTIONS="--default-ulimit nofile=1024:4096 -H unix:///var/run/docker.sock -H tcp://0.0.0.0:2376 --tlsverify --tlskey /home/ec2-user/server-key.pem --tlscert /home/ec2-user/server-cert.pem --tlscacert=/home/ec2-user/ca.pem"
```

Test that the config works:

```
$ export YOUR_PRIVATE_IP=$(
  ip addr show eth0 \
  | grep -o -e '[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+' \
  | head -n1
)
```

```
sudo service docker restart

# Through the lookback device
sudo docker --tlsverify --tlscacert ca.pem --tlscert cert.pem --tlskey key.pem -H $YOUR_PRIVATE_IP:2376 version
# Through the IP designated as SAN in openssl's configuration
sudo docker --tlsverify --tlscacert ca.pem --tlscert cert.pem --tlskey key.pem -H localhost:2376 version
# Through the unix socket
docker version
```

[Install drone-cli](https://github.com/drone/drone-cli#installation)

```
curl http://downloads.drone.io/drone-cli/drone_linux_amd64.tar.gz | tar zx
sudo install -t /usr/local/bin drone
```

```
$ scp -i ~/.ssh/your.pem ec2-user@52.192.123.183:cert.pem .
cert.pem                                                          100%  993     1.0KB/s   00:00
$ scp -i ~/.ssh/your.pem cert.pem ec2-user@52.193.185.167:
cert.pem
```

Or send certs and keys from the worker to the drone master via S3:

```
# On the worker node
export YOUR_BUCKET=...
export YOUR_PRIVATE_IP=...

sudo yum install aws-cli -y

aws s3 cp ca.pem s3://$YOUR_BUCKET/nodes/$YOUR_PRIVATE_IP/
aws s3 cp cert.pem s3://$YOUR_BUCKET/nodes/$YOUR_PRIVATE_IP/
aws s3 cp key.pem s3://$YOUR_BUCKET/nodes/$YOUR_PRIVATE_IP/

# On the master node


```

```
export DRONE_SERVER=<URL for your drone server>
export DRONE_TOKEN=<The API token shown in the profile page in drone's Web UI>

export DOCKER_CERT_PATH=$(pwd); docker --tlsverify -H 10.2.2.51:2376 version

$ drone node create --docker-host tcp://10.2.2.51:2376 --docker-tls-verify 1 --docker-cert-path ~/
Successfully added tcp://10.2.2.51:2376

$ drone node ls
3 tcp://10.2.2.51:2376
1 unix:///var/run/docker.sock
2 unix:///var/run/docker.sock
```

## Trouble-shooting

### Missing ca.pem on client

```
[ec2-user@ip-10-2-2-230 ~]$ export DOCKER_CERT_PATH=$(pwd); docker --tlsverify -H 10.2.2.51:2376 version
Could not read CA certificate "/home/ec2-user/ca.pem": open /home/ec2-user/ca.pem: no such file or directory
```

### Missing key.pem on client or missing SAN in server's cert

```
The server probably has client authentication (--tlsverify) enabled. Please check your TLS client certification settings: Get https://10.2.2.51:2376/v1.21/version: remote error: bad certificate
```

## References

### Securing docker daemon

* [certificate - OpenSSL Version V3 with Subject Alternative Name - Stack Overflow](http://stackoverflow.com/questions/6194236/openssl-version-v3-with-subject-alternative-name)
* [TLS認証なDocker Swarmクラスタを構築 (docker-machineなしで) - Namiking.net](http://blog.namiking.net/post/2016/01/docker-swarm-build-using-tls/)
  * I had to add an `-extension v3_req` option to openssl
* [Protect the Docker daemon socket](https://docs.docker.com/engine/security/https/)
  * Missed a tiny detail for me
* [Generate trusted CA certificates for running Docker with HTTPS](https://gist.github.com/bradrydzewski/a6090115b3fecfc25280)
* [Generate self-signed SSL certs for docker client <— HTTPS —> daemon](https://gist.github.com/cameron/10797040)
   * I had to add an `SAN` pointing the IP address of the host running docker daemon
   * `docker --tls ...` configuration doesn't apply for drone worker. drone requires `--tlsverify` instead of `--tls`
* [Problem in HTTPS connection · Issue #8943 · docker/docker](https://github.com/docker/docker/issues/8943)

### Caching

* [Drone doesn't seem to cache layers · Issue #34 · drone-plugins/drone-docker](https://github.com/drone-plugins/drone-docker/issues/34)
* [Dockerのイメージはどこにある? | SOTA](http://deeeet.com/writing/2013/12/16/where-are-docker-images-storede/)

### Automation

* [AWS EC2 Container Service (ECS) Cloudformation Template - Tips, Tricks, and How-To's - Drone Discussion](https://discuss.drone.io/t/aws-ec2-container-service-ecs-cloudformation-template/133)
* [Drone CI environment with Distributed workers.](https://github.com/hence-io/rancher-templates/tree/master/drone)
  * Though it didn't work out of the box for me, its cfn template is the foundation of the template used in this project.
* [How to add a Drone Worker through Drone API - Help! - Drone Discussion](https://discuss.drone.io/t/how-to-add-a-drone-worker-through-drone-api/67/10)
* [changing worker pool requires restart? · Issue #1455 · drone/drone](https://github.com/drone/drone/issues/1455)
  * I'm one of those who are waiting for v0.5!

### Performance Tuning

* [Benchmark: Boot Time Comparison in OpsWorks | Celingest Blog – Feel the Cloud](http://blog.celingest.com/en/2014/04/25/benckmark-boot-time-comparison-opsworks/)

### Amazon S3

* [AWS S3 で listObjects が "AccessDenied" を返す場合 - Qiita](http://qiita.com/macoshita/items/e3316ffc45a8eac1c9c8)

### Customizing Drone

* [Wrapper script for dealing with environment variables set by the `-link container_name:db` argument. The Dockerfile `ENV` directive will set a static environment variable inside the container, but it's not possible to reference dynamic environment variables (at least not very easily) with ENV. This script should be set as the `ENTRYPOINT` in an application's Dockerfile, setting the proper execution environment for arbitrary commands passed as arguments to `docker run`](https://gist.github.com/mikeclarke/7620336)

### Dockerode

* [Error: self signed certificate in certificate chain · Issue #154 · apocas/dockerode](https://github.com/apocas/dockerode/issues/154)
