# Live cluster for the integration checks

A small cluster to exercise the Elasticsearch/Kibana (#483, #505) and
Prometheus/Grafana (#484) integrations end to end: ECK with one
Elasticsearch node, Kibana and Filebeat (ECS logs), kube-prometheus-stack
(Prometheus, kube-state-metrics, Grafana) and a `shop/api` deployment that
logs JSON and plain lines.

```sh
# minikube on podman (about 6 GiB); keep your current kubectl context
minikube start --driver=podman --container-runtime=containerd --memory=6g --cpus=4
kubectl config use-context <your previous context>

helm repo add elastic https://helm.elastic.co
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm --kube-context minikube install elastic-operator elastic/eck-operator \
  -n elastic-system --create-namespace --wait
helm --kube-context minikube install kps prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace -f scripts/live-cluster/prom-values.yaml
kubectl --context minikube create namespace logging
kubectl --context minikube apply -f scripts/live-cluster/elastic.yaml -f scripts/live-cluster/demo.yaml
```

Wait until `kubectl --context minikube -n logging get elasticsearch,kibana,beat`
reports health (yellow is expected with one node), then run:

```sh
# Rust core (desktop backend)
CUBELITE_LIVE_CONTEXT=minikube cargo test -p cubelite-core --test live_integrations -- --ignored --nocapture

# Swift services (macOS)
cd apps/macos/cubelite && TEST_RUNNER_CUBELITE_LIVE_CONTEXT=minikube xcodebuild test \
  -project cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' \
  -only-testing cubeliteTests/LiveIntegrationsTests
```

In the apps: Preferences → Elasticsearch / Prometheus → In cluster → Detect.
Elasticsearch uses "ECK elastic user"; Prometheus the cluster credentials.
