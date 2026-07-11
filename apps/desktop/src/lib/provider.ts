/** Best-effort provider label for a kube context (titlebar/palette chip). */
export function providerOf(name: string, server: string | null): string {
  const hay = `${name} ${server ?? ""}`.toLowerCase();
  if (hay.includes("azmk8s") || hay.includes("aks")) return "AKS";
  if (hay.includes("amazonaws") || hay.includes("eks")) return "EKS";
  if (hay.includes("gke")) return "GKE";
  if (hay.includes("k3d") || hay.includes("k3s")) return "K3S";
  if (hay.includes("kind")) return "KIND";
  if (hay.includes("minikube") || hay.includes("docker-desktop") || hay.includes("localhost") || hay.includes("127.0.0.1"))
    return "LOCAL";
  return "K8S";
}
