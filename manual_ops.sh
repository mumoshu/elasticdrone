#!/bin/bash

set -vxe

function config_github_client_id() {
  config_get "GITHUB_CLIENT_ID"
}

function config_github_client_secret() {
  config_get "GITHUB_CLIENT_SECRET"
}

function config_vpc_id() {
  config_get "VPC_ID"
}

function config_allowed_cidr() {
  config_get "ALLOWED_CIDR"
}

function config_subnet1() {
  config_get "SUBNET1"
}

function config_subnet2() {
  config_get "SUBNET2"
}

function config_keyname() {
  config_get "KEYNAME"
}

function config_get() {
  local value
  eval value=\$$1
  if [ "$value" != "" ]; then
    echo $value
  else
    echo "The environment variable $1 is not defined." >&2
    return 1
  fi
}

function stack_name() {
  config_get "STACK_NAME"
}

function bucket_name() {
  aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "BucketName") | .OutputValue'
}

function stack_update() {
  aws cloudformation update-stack --stack-name $(stack_name) \
    --template-body file://$(pwd)/droneci.json \
    --parameters "ParameterKey=DroneRemoteDriver,ParameterValue=github" \
    "ParameterKey=DroneRemoteConfig,ParameterValue=https://github.com?client_id=$(config_github_client_id)&client_secret=$(config_github_client_secret)" \
    "ParameterKey=VPC,ParameterValue=$(config_vpc_id)" \
    "ParameterKey=Subnets,ParameterValue=$(config_subnet1),ParameterValue=$(config_subnet2)" \
    "ParameterKey=KeyName,ParameterValue=$(config_keyname)" \
    ParameterKey=IncomingYourRequestCidr,ParameterValue="$(config_allowed_cidr)" \
    ParameterKey=DroneWorkerCacheSnapshotId,UsePreviousValue=true \
    --capabilities CAPABILITY_IAM
}

function oauth_endpoint() {
  aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "OAuthEndpoint") | .OutputValue'
}

function api_token() {
  echo
}

function api_endpoint() {
  echo
}

# Usage:
#   eval $(./ctl.sh drone_cli_config)
#   drone node ls
function drone_cli_config() {
  cat <<EOS
export DRONE_TOKEN=$(api_token)
export DRONE_SERVER=$(api_endpoint)
EOS
}

function worker_set_drone_token() {
  local token=$1
  local bucket=$(bucket_name)
  # FIXME
  local tempfile=.drone_token
  echo "$token" > $tempfile
  aws s3 cp $tempfile s3://$bucket/roles/worker/env/DRONE_TOKEN
  rm $tempfile
}

function worker_get_drone_token() {
  local bucket=$(aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "BucketName") | .OutputValue')
  aws s3 cp s3://$bucket/roles/worker/env/DRONE_TOKEN -
}

function worker_set_drone_server() {
  local asg=$(master_asg)
  local instance_id=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $asg | jq -r .AutoScalingGroups[0].Instances[0].InstanceId)
  local drone_server=$(aws ec2 describe-instances --instance-id $instance_id | jq -r .Reservations[].Instances[].PrivateIpAddress)
  local bucket=$(aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "BucketName") | .OutputValue')
  # FIXME
  local tempfile=.drone_server
  echo "http://$drone_server" > $tempfile
  aws s3 cp $tempfile s3://$bucket/roles/worker/env/DRONE_SERVER
  rm $tempfile
}

function worker_upload_scripts() {
  local bucket=$(aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "BucketName") | .OutputValue')
  aws s3 cp generate_docker_cert.sh s3://$bucket/roles/worker/scripts/generate_docker_cert.sh
}

function global_upload_ssh_private_key() {
  local bucket=$(aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "BucketName") | .OutputValue')
  aws s3 cp $SSH_PRIVATE_KEY s3://$bucket/global/ssh_private_key.pem
}

function worker_asg() {
  aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "WorkerAutoScalingGroup") | .OutputValue'
}

function worker_scale() {
  aws autoscaling set-desired-capacity --auto-scaling-group-name $(worker_asg) --desired-capacity $1
}

function worker_connection_test() {
  local node_id=$1
  local ip=$2
  local bucket=$(bucket_name)
  aws s3 cp s3://$bucket/nodes/$node_id/cert.pem .
  aws s3 cp s3://$bucket/nodes/$node_id/key.pem .
  aws s3 cp s3://$bucket/nodes/$node_id/ca.pem .
  export DOCKER_CERT_PATH=$(pwd); docker --tlsverify -H tcp://$ip:2376 ps
}

function node_docker() {
  local node_id=$1
  local ip=$2
  local bucket=$(bucket_name)
  aws s3 cp s3://$bucket/nodes/$node_id/cert.pem .
  aws s3 cp s3://$bucket/nodes/$node_id/key.pem .
  aws s3 cp s3://$bucket/nodes/$node_id/ca.pem .
  export DOCKER_CERT_PATH=$(pwd); docker --tlsverify -H tcp://$ip:2376 $3 $4
}

function master_asg() {
  aws cloudformation describe-stacks --stack-name $(stack_name) | jq -r '.Stacks[].Outputs[] | select(.OutputKey == "MasterAutoScalingGroup") | .OutputValue'
}

function master_ssh() {
  local asg=$(master_asg)
  local instance_id=$(asg_first_instance $asg)
  local public_ip=$(ec2instance_public_ip $instance_id)
  ssh -i $SSH_PRIVATE_KEY ec2-user@$public_ip
}

function master_docker_restart_drone() {
  local asg=$(master_asg)
  local instance_id=$(asg_first_instance $asg)
  local public_ip=$(ec2instance_public_ip $instance_id)
  local private_ip=$(ec2instance_private_ip $instance_id)
  node_docker $private_ip $public_ip restart drone
}

function worker_ssh() {
  local asg=$(worker_asg)
  local instance_id=$(asg_first_instance $asg)
  local public_ip=$(ec2instance_public_ip $instance_id)
  ssh -i $SSH_PRIVATE_KEY ec2-user@$public_ip
}

function worker_docker() {
  local asg=$(worker_asg)
  local instance_id=$(asg_first_instance $asg)
  local public_ip=$(ec2instance_public_ip $instance_id)
  local private_ip=$(ec2instance_private_ip $instance_id)
  node_docker $private_ip $public_ip $1
}

# ./ctl.sh worker_demux $PRIVATE_IP
function worker_demux() {
    local node_id=$1
    local bucket=$(bucket_name)
    aws s3 cp s3://$bucket/nodes/$node_id/cert.pem .
    aws s3 cp s3://$bucket/nodes/$node_id/key.pem .
    aws s3 cp s3://$bucket/nodes/$node_id/ca.pem .
    drone node create --docker-host tcp://$node_id:2376 --docker-tls-verify --docker-cert-path .
}

function worker_nth_ec2instance_data() {
  local asg=$(worker_asg)
  local instance_id=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $asg | jq -r .AutoScalingGroups[0].Instances[$1].InstanceId)
  aws ec2 describe-instances --instance-id $instance_id | jq -r .Reservations[].Instances[]
}

function asg_first_instance() {
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $1 | jq -r .AutoScalingGroups[0].Instances[0].InstanceId
}

function ec2instance_public_ip() {
  aws ec2 describe-instances --instance-id $1 | jq -r .Reservations[].Instances[].PublicIpAddress
}

function ec2instance_private_ip() {
  aws ec2 describe-instances --instance-id $1 | jq -r .Reservations[].Instances[].PrivateIpAddress
}

"$@"
