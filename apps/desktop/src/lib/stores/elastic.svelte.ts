/**
 * Elasticsearch endpoints per kube context (#501, spec
 * docs/superpowers/specs/2026-11-03-elastic-kibana-design.md §3), and the
 * default shared by every context (#528) with a per-context cluster filter.
 */
import { mergeClusterFilter, type ElasticContextSettings } from "#lib/elastic.ts";
import type { EsEndpoint } from "#lib/tauri.ts";
import { EndpointStore } from "./endpoints.svelte";

export const elastic = new EndpointStore<EsEndpoint, ElasticContextSettings>("elastic.endpoints", mergeClusterFilter);
