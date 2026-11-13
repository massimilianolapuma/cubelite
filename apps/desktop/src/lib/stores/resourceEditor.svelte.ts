/**
 * The resources editor (spec #650 §3.2, §6.3): one open editor at a time, on
 * one deployment. It holds the facts read when it opened, what is typed, the
 * core's check of it (debounced, the latest answer wins), the step, the dry
 * run and the apply. The check is the core's: nothing here judges a value.
 */

import {
  applyResources,
  clearResourcesOverride,
  evaluateResources,
  resourceFacts,
  type DeploymentInfo,
  type ResourceEvaluation,
  type ResourceFacts,
  type ResourceField,
  type ResourceName,
  type ResourceProposal,
} from "#lib/tauri.ts";
import { errorMessage } from "#lib/errors.ts";
import {
  RESTORE_PROPOSAL,
  buildProposal,
  editableContainers,
  initialDrafts,
  isBlocked,
  quickStep as quickStepText,
  type Drafts,
  type FieldKey,
} from "#lib/resource-editor.ts";
import { app } from "./app.svelte";
import { resources } from "./resources.svelte";
import { toasts } from "./toasts.svelte";

/** Idle time after the last keystroke before the check runs. */
export const EVALUATE_DEBOUNCE_MS = 300;

export type EditorMode = "adjust" | "restore";
export type EditorStep = "edit" | "review";

function key(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

class ResourceEditorStore {
  /** The deployment being edited; null when the editor is closed. */
  target = $state<{ namespace: string; name: string } | null>(null);
  mode = $state<EditorMode>("adjust");
  step = $state<EditorStep>("edit");
  facts = $state.raw<ResourceFacts | null>(null);
  factsError = $state<string | null>(null);
  loading = $state(false);
  drafts = $state<Drafts>({});
  /** The check of the current drafts, or the dry run's answer. */
  evaluation = $state.raw<ResourceEvaluation | null>(null);
  /** The drafts are newer than `evaluation`. */
  evaluating = $state(false);
  /** Why the last check could not run (it runs locally: rare). */
  evaluateError = $state<string | null>(null);
  dryRun = $state<"idle" | "running" | "ok" | "failed">("idle");
  dryRunError = $state<string | null>(null);
  applying = $state(false);
  applyError = $state<string | null>(null);

  /** Keys of deployments with an apply in flight. */
  #pendingApplies = $state<Record<string, boolean>>({});
  /** Kubeconfig and cluster the facts were read from: every call of this editor goes there. */
  #kubeconfig: string | null = null;
  #cluster: string | null = null;
  /** The proposal the dry run checked: the apply sends this one. */
  #proposal: ResourceProposal | null = null;
  /** Bumped by every open and close: an answer for an older editor is dropped. */
  #session = 0;
  /** Bumped by every check request: only the latest answer is kept. */
  #evalSeq = 0;
  /** Bumped by every dry run and by Back: only the current dry run's answer is kept. */
  #dryRunSeq = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopWatch: (() => void) | null = null;

  /** Some field differs from the cluster's text (a restore is a change by itself). */
  get changed(): boolean {
    if (this.mode === "restore") return true;
    const facts = this.facts;
    return facts !== null && buildProposal(facts, this.drafts).containers.length > 0;
  }

  /** Review can open: something changed, the check of the latest text answered, nothing is blocked. */
  get canReview(): boolean {
    return (
      this.target !== null &&
      this.mode === "adjust" &&
      this.step === "edit" &&
      this.facts !== null &&
      this.changed &&
      !this.evaluating &&
      this.evaluation !== null &&
      !isBlocked(this.evaluation)
    );
  }

  isApplying(namespace: string, name: string): boolean {
    return this.#pendingApplies[key(namespace, name)] ?? false;
  }

  /** Open the editor on `deployment`; a restore opens on step 2. Ignored while an apply runs. */
  async open(deployment: DeploymentInfo, mode: EditorMode = "adjust"): Promise<void> {
    if (this.applying) return;
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return;
    this.#reset();
    this.#kubeconfig = kc;
    this.#cluster = cluster;
    this.target = { namespace: deployment.namespace, name: deployment.name };
    this.mode = mode;
    this.step = mode === "restore" ? "review" : "edit";
    this.#watch();
    await this.#readFacts();
  }

  /** Close the editor. Ignored while an apply runs. */
  close(): void {
    if (this.applying) return;
    this.#reset();
  }

  /** Read the facts again, after they could not be read. */
  async retry(): Promise<void> {
    if (this.target === null || this.applying || this.loading) return;
    await this.#readFacts();
  }

  setField(container: string, key: FieldKey, text: string): void {
    if (!this.#editable() || this.drafts[container] === undefined) return;
    this.drafts[container][key] = text;
    this.#schedule();
  }

  /** A quick step on one field, from the cluster's value; nothing when the cluster has none. */
  quickStep(container: string, key: FieldKey, factor: 1.25 | 1.5 | 2): void {
    if (!this.#editable() || this.facts === null) return;
    const c = editableContainers(this.facts).find((e) => e.name === container);
    if (c === undefined) return;
    const [resource, field] = key.split(".") as [ResourceName, ResourceField];
    const text = quickStepText(resource, c.resources[resource][field]?.amount ?? null, factor);
    if (text !== null) this.setField(container, key, text);
  }

  /** Put one container back to the cluster's values. */
  reset(container: string): void {
    if (!this.#editable() || this.facts === null) return;
    const original = initialDrafts(this.facts)[container];
    if (original === undefined) return;
    this.drafts[container] = original;
    this.#schedule();
  }

  /** To step 2: runs the server-side dry run of the exact proposal. */
  async review(): Promise<void> {
    const facts = this.facts;
    const target = this.target;
    if (facts === null || target === null || this.applying) return;
    if (this.mode === "adjust") {
      if (!this.canReview) return;
      this.step = "review";
    }
    const proposal = this.mode === "restore" ? RESTORE_PROPOSAL : buildProposal(facts, this.drafts);
    this.#proposal = proposal;
    this.dryRun = "running";
    this.dryRunError = null;
    this.applyError = null;
    const seq = ++this.#dryRunSeq;
    try {
      const answer = await applyResources(
        this.#kubeconfig ?? "",
        target.namespace,
        target.name,
        proposal,
        facts.seen,
        true,
        this.#cluster ?? undefined,
      );
      if (seq !== this.#dryRunSeq) return;
      this.evaluation = answer;
      this.dryRun = "ok";
    } catch (e) {
      if (seq !== this.#dryRunSeq) return;
      this.dryRun = "failed";
      this.dryRunError = errorMessage(e);
    }
  }

  /** Back to step 1 with the fields as they were. A restore has no step 1. */
  back(): void {
    if (this.mode !== "adjust" || this.step !== "review" || this.applying) return;
    ++this.#dryRunSeq;
    this.step = "edit";
    this.dryRun = "idle";
    this.dryRunError = null;
    this.applyError = null;
    this.#proposal = null;
  }

  /** Apply what the dry run checked. One request at a time; refused unless the dry run is ok. */
  async apply(): Promise<boolean> {
    const facts = this.facts;
    const target = this.target;
    const proposal = this.#proposal;
    if (facts === null || target === null || proposal === null) return false;
    if (this.step !== "review" || this.dryRun !== "ok" || this.applying) return false;
    const k = key(target.namespace, target.name);
    const restore = this.mode === "restore";
    this.applying = true;
    this.applyError = null;
    this.#pendingApplies = { ...this.#pendingApplies, [k]: true };
    try {
      await applyResources(
        this.#kubeconfig ?? "",
        target.namespace,
        target.name,
        proposal,
        facts.seen,
        false,
        this.#cluster ?? undefined,
      );
      this.applying = false;
      this.close();
      toasts.push(
        `Resources of ${target.name} ${restore ? "restored" : "updated"}, rollout started`,
        "ok",
      );
      void resources.load();
      return true;
    } catch (e) {
      this.applyError = errorMessage(e);
      return false;
    } finally {
      this.applying = false;
      const rest = { ...this.#pendingApplies };
      delete rest[k];
      this.#pendingApplies = rest;
    }
  }

  /** "Keep these values": remove the override mark, nothing else. */
  async keepValues(deployment: DeploymentInfo): Promise<boolean> {
    const kc = app.kubeconfigPath;
    const cluster = app.activeCluster;
    if (!kc || !cluster) return false;
    try {
      await clearResourcesOverride(kc, deployment.namespace, deployment.name, cluster);
      toasts.push(`Override mark removed from ${deployment.name}`, "ok");
      void resources.load();
      return true;
    } catch (e) {
      toasts.push(`Could not remove the mark: ${errorMessage(e)}`, "err");
      return false;
    }
  }

  /** Fields take typing on step 1 of an adjust whose facts are read. */
  #editable(): boolean {
    return this.facts !== null && this.mode === "adjust" && this.step === "edit" && !this.applying;
  }

  async #readFacts(): Promise<void> {
    const target = this.target;
    if (target === null) return;
    const session = this.#session;
    this.loading = true;
    this.factsError = null;
    let facts: ResourceFacts;
    try {
      facts = await resourceFacts(
        this.#kubeconfig ?? "",
        target.namespace,
        target.name,
        this.#cluster ?? undefined,
      );
    } catch (e) {
      if (session !== this.#session) return;
      this.loading = false;
      this.factsError = errorMessage(e);
      return;
    }
    if (session !== this.#session) return;
    this.facts = facts;
    this.drafts = initialDrafts(facts);
    this.loading = false;
    // The cluster's values checked at once: the nodes and the notes show before any typing.
    await this.#evaluate(++this.#evalSeq);
    if (session !== this.#session) return;
    if (this.mode === "restore") void this.review();
  }

  /** One check, EVALUATE_DEBOUNCE_MS after the last change. */
  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    const seq = ++this.#evalSeq;
    this.evaluating = true;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#evaluate(seq);
    }, EVALUATE_DEBOUNCE_MS);
  }

  /** The check of the drafts as they are now; dropped if a newer one was asked for meanwhile. */
  async #evaluate(seq: number): Promise<void> {
    const facts = this.facts;
    if (facts === null) return;
    const proposal = this.mode === "restore" ? RESTORE_PROPOSAL : buildProposal(facts, this.drafts);
    this.evaluating = true;
    try {
      const answer = await evaluateResources(facts, proposal);
      if (seq !== this.#evalSeq) return;
      this.evaluation = answer;
      this.evaluateError = null;
    } catch (e) {
      if (seq !== this.#evalSeq) return;
      this.evaluation = null;
      this.evaluateError = errorMessage(e);
    }
    this.evaluating = false;
  }

  /**
   * Close the editor when its deployment leaves a list that answered (deleted
   * elsewhere), with a toast, unless an apply runs; and without one when the
   * active cluster changes.
   */
  #watch(): void {
    this.#stopWatch = $effect.root(() => {
      $effect(() => {
        const target = this.target;
        if (target === null || this.applying) return;
        if (app.activeCluster !== this.#cluster) {
          this.close();
          return;
        }
        if (!resources.mainLoaded || resources.listError("deployments") !== null) return;
        const listed = resources.deployments.some(
          (d) => d.namespace === target.namespace && d.name === target.name,
        );
        if (!listed) {
          this.close();
          toasts.push(`Deployment ${target.name} is gone`, "warn");
        }
      });
    });
  }

  #reset(): void {
    ++this.#session;
    ++this.#evalSeq;
    ++this.#dryRunSeq;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const stop = this.#stopWatch;
    this.#stopWatch = null;
    stop?.();
    this.#kubeconfig = null;
    this.#cluster = null;
    this.#proposal = null;
    this.target = null;
    this.mode = "adjust";
    this.step = "edit";
    this.facts = null;
    this.factsError = null;
    this.loading = false;
    this.drafts = {};
    this.evaluation = null;
    this.evaluating = false;
    this.evaluateError = null;
    this.dryRun = "idle";
    this.dryRunError = null;
    this.applying = false;
    this.applyError = null;
  }
}

export const resourceEditor = new ResourceEditorStore();
