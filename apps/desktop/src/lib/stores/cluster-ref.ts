/**
 * Where an action goes (#685): the kubeconfig and the context it was started
 * on, taken when its dialog, editor or button was used. A cluster switch does
 * not move it: it goes on to the cluster it was started on, and what it shows
 * while it runs stays on that cluster.
 */

import { app } from "./app.svelte";

export interface ClusterRef {
  kubeconfig: string;
  cluster: string;
}

/** The active kubeconfig and context; null when there is none. */
export function activeClusterRef(): ClusterRef | null {
  const kubeconfig = app.kubeconfigPath;
  const cluster = app.activeCluster;
  return kubeconfig && cluster ? { kubeconfig, cluster } : null;
}

/**
 * `ref` is the cluster on screen: the active one, with no switch to another
 * one running. A switch keeps the old cluster active until its context is
 * set, but its lists are being cleared and the user has moved on.
 */
export function onScreen(ref: ClusterRef): boolean {
  return (
    app.activeCluster === ref.cluster &&
    app.kubeconfigPath === ref.kubeconfig &&
    (app.connecting === null || app.connecting === ref.cluster)
  );
}

/** A key for `namespace/name` on `ref`: the same name on another cluster is another key. */
export function refKey(ref: ClusterRef, namespace: string, name: string): string {
  return JSON.stringify([ref.kubeconfig, ref.cluster, namespace, name]);
}

/** " on <cluster>" when `ref` is not on screen; empty when it is. */
export function elsewhere(ref: ClusterRef): string {
  return onScreen(ref) ? "" : ` on ${ref.cluster}`;
}
