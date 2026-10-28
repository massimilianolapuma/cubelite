<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { prettyJson, type JsonValue, type JsonObject } from "#lib/log-json.ts";
  import JsonTree from "./JsonTree.svelte";

  interface Props {
    value: JsonValue;
    raw: string;
    depth?: number;
  }

  let { value, raw, depth = 0 }: Props = $props();

  // Children at depth >= 2 start collapsed; a key in `flipped` inverts that default.
  const flipped = new SvelteSet<string>();
  const defaultOpen = $derived(depth + 1 < 2);

  function isComposite(v: JsonValue): v is JsonObject | JsonValue[] {
    return typeof v === "object" && v !== null;
  }

  const entries = $derived<[string, JsonValue][]>(
    Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : isComposite(value)
        ? Object.entries(value)
        : [],
  );

  function isOpen(key: string): boolean {
    return defaultOpen !== flipped.has(key);
  }

  function toggle(key: string): void {
    if (flipped.has(key)) flipped.delete(key);
    else flipped.add(key);
  }

  function placeholder(v: JsonObject | JsonValue[]): string {
    return Array.isArray(v) ? `[${v.length} items]` : `{${Object.keys(v).length} keys}`;
  }

  function scalarType(v: JsonValue): "string" | "number" | "boolean" | "null" {
    if (v === null) return "null";
    if (typeof v === "string") return "string";
    if (typeof v === "number") return "number";
    return "boolean";
  }

  const SCALAR_COLOR = {
    string: "var(--color-cluster-teal)",
    number: "var(--color-cluster-amber)",
    boolean: "var(--color-cluster-violet)",
    null: "var(--color-cluster-violet)",
  } as const;

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable */
    }
  }
</script>

{#snippet label(key: string)}
  {#if Array.isArray(value)}
    <span class="text-text-tertiary">[{key}]</span>
  {:else}
    <span class="text-text-secondary">{key}</span>
    <span class="text-text-tertiary">:</span>
  {/if}
{/snippet}

<div data-testid={depth === 0 ? "json-tree" : undefined} class="type-micro font-mono">
  {#if depth === 0}
    <div class="flex gap-2 pb-1">
      <button
        type="button"
        class="type-caption text-text-secondary hover:underline"
        aria-label="Copy JSON"
        onclick={() => copy(isComposite(value) && !Array.isArray(value) ? prettyJson(value) : JSON.stringify(value, null, 2))}
      >Copy JSON</button>
      <button
        type="button"
        class="type-caption text-text-secondary hover:underline"
        aria-label="Copy raw"
        onclick={() => copy(raw)}
      >Copy raw</button>
    </div>
  {/if}
  {#if !isComposite(value)}
    <span class="break-words" data-json={scalarType(value)} style="color: {SCALAR_COLOR[scalarType(value)]}"
      >{JSON.stringify(value)}</span
    >
  {:else}
    {#each entries as [key, child] (key)}
      <!-- Relative indent: nested trees sit inside the parent row, so 12px per level compounds to depth * 12. -->
      <div style="padding-left: {depth > 0 ? 12 : 0}px">
        {#if isComposite(child) && Object.keys(child).length === 0}
          {@render label(key)}
          <span class="text-text-tertiary" data-json="empty">{Array.isArray(child) ? "[]" : "{}"}</span>
        {:else if isComposite(child)}
          {@const open = isOpen(key)}
          <button
            type="button"
            class="inline-flex items-center"
            aria-expanded={open}
            aria-label="Toggle {key}"
            onclick={() => toggle(key)}
          >
            <ChevronRight size={10} class={open ? "rotate-90" : ""} />
          </button>
          {@render label(key)}
          {#if open}
            <JsonTree value={child} {raw} depth={depth + 1} />
          {:else}
            <span class="text-text-tertiary">{placeholder(child)}</span>
          {/if}
        {:else}
          {@render label(key)}
          <span class="break-words" data-json={scalarType(child)} style="color: {SCALAR_COLOR[scalarType(child)]}"
            >{JSON.stringify(child)}</span
          >
        {/if}
      </div>
    {/each}
  {/if}
</div>
