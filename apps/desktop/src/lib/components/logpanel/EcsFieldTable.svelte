<script lang="ts">
  import { jsonText, type JsonValue } from "#lib/log-json.ts";
  import { ecsJson, ecsTable, type EcsDocument } from "#lib/log-ecs.ts";

  interface Props {
    doc: EcsDocument;
    raw: string;
  }

  let { doc, raw }: Props = $props();

  const rows = $derived(ecsTable(doc));

  function kind(v: JsonValue): "string" | "number" | "boolean" | "null" | "composite" {
    if (v === null) return "null";
    if (typeof v === "string") return "string";
    if (typeof v === "number" || typeof v === "bigint") return "number";
    if (typeof v === "boolean") return "boolean";
    return "composite";
  }

  const COLOR = {
    string: "var(--color-cluster-teal)",
    number: "var(--color-cluster-amber)",
    boolean: "var(--color-cluster-violet)",
    null: "var(--color-cluster-violet)",
    composite: "var(--color-text-secondary)",
  } as const;

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable */
    }
  }
</script>

<!-- Kibana-like document table (#492): flattened ECS fields sorted by name. -->
<div data-testid="ecs-table" class="type-micro font-mono">
  <div class="flex gap-2 pb-1">
    <button
      type="button"
      class="type-caption text-text-secondary hover:underline"
      aria-label="Copy ECS"
      onclick={() => copy(ecsJson(doc, 2))}>Copy ECS</button
    >
    <button
      type="button"
      class="type-caption text-text-secondary hover:underline"
      aria-label="Copy raw"
      onclick={() => copy(raw)}>Copy raw</button
    >
  </div>
  <table class="w-full border-collapse">
    <tbody>
      {#each rows as field (field.key)}
        {@const k = kind(field.value)}
        <tr data-field={field.key} class="align-top">
          <td class="w-px pr-4 whitespace-nowrap text-text-secondary">{field.key}</td>
          <td class="break-all whitespace-pre-wrap" data-json={k} style="color: {COLOR[k]}"
            >{typeof field.value === "string" ? field.value : jsonText(field.value)}{#if field.added}<span
                class="ml-1.5 text-text-tertiary"
                title="Added by CubeLite, not in the log line">added</span
              >{/if}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
</div>
