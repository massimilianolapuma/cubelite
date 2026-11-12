<script lang="ts">
  import { jsonText, type JsonValue } from "#lib/log-json.ts";
  import { ecsJson, ecsTable, type EcsDocument } from "#lib/log-ecs.ts";
  import { INLINE_ACTION as COPY } from "#lib/ui-classes.ts";

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

  // Same value colours as the JSON tree (Tonal §8.5), written in full.
  const TONE = {
    string: "text-text",
    number: "text-data-2",
    boolean: "text-data-3",
    null: "text-data-3",
    composite: "text-text",
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
<div data-testid="ecs-table" class="type-log">
  <div class="flex gap-1 pb-1">
    <button
      type="button"
      class={COPY}
      aria-label="Copy ECS"
      onclick={() => copy(ecsJson(doc, 2))}>Copy ECS</button
    >
    <button
      type="button"
      class={COPY}
      aria-label="Copy raw"
      onclick={() => copy(raw)}>Copy raw</button
    >
  </div>
  <table class="w-full border-collapse">
    <tbody>
      {#each rows as field (field.key)}
        {@const k = kind(field.value)}
        <tr data-field={field.key} class="align-top">
          <td class="w-px pr-4 whitespace-nowrap text-text-muted">{field.key}</td>
          <td class="break-all whitespace-pre-wrap {TONE[k]}" data-json={k}
            >{typeof field.value === "string" ? field.value : jsonText(field.value)}{#if field.added}<span
                class="type-body-sm ml-1.5 text-text-muted"
                title="Added by CubeLite, not in the log line">added</span
              >{/if}</td
          >
        </tr>
      {/each}
    </tbody>
  </table>
</div>
