/**
 * Elasticsearch endpoints per kube context (#501, spec
 * docs/superpowers/specs/2026-11-03-elastic-kibana-design.md §3).
 */
import type { EsEndpoint } from "#lib/tauri.ts";
import { EndpointStore } from "./endpoints.svelte";

export const elastic = new EndpointStore<EsEndpoint>("elastic.endpoints");
