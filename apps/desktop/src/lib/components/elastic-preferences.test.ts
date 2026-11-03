import { describe, it, expect, beforeEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("#lib/tauri.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/tauri.ts")>()),
  elasticDetect: vi.fn(),
  elasticTest: vi.fn(),
  elasticSaveAuth: vi.fn(async () => {}),
  elasticAuthMethod: vi.fn(async () => "none"),
  elasticUseEckCredentials: vi.fn(async () => "eck-user"),
}));

import ElasticPreferences from "./ElasticPreferences.svelte";
import { app } from "#lib/stores/app.svelte.ts";
import { elastic } from "#lib/stores/elastic.svelte.ts";
import {
  elasticAuthMethod,
  elasticDetect,
  elasticSaveAuth,
  elasticTest,
  elasticUseEckCredentials,
} from "#lib/tauri.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(elasticAuthMethod).mockResolvedValue("none");
  app.activeCluster = "prod";
  app.kubeconfigPath = "/k";
  elastic.setEndpoint("prod", null);
});

async function chooseInCluster() {
  render(ElasticPreferences);
  await fireEvent.click(screen.getByRole("radio", { name: "In cluster" }));
}

describe("ElasticPreferences (#501)", () => {
  it("detects services and fills the in-cluster target", async () => {
    vi.mocked(elasticDetect).mockResolvedValueOnce([
      { kind: "elasticsearch", namespace: "logging", name: "quickstart-es-http", port: 9200, https: true },
      { kind: "kibana", namespace: "logging", name: "quickstart-kb-http", port: 5601, https: true },
    ]);
    await chooseInCluster();
    await fireEvent.click(screen.getByRole("button", { name: "Detect" }));
    await fireEvent.click(await screen.findByRole("button", { name: "Use" }));
    expect(screen.getByLabelText("Namespace")).toHaveValue("logging");
    expect(screen.getByLabelText("Service")).toHaveValue("quickstart-es-http");
    expect(screen.getByLabelText("Port")).toHaveValue(9200);
    expect(elasticDetect).toHaveBeenCalledWith("/k", "prod");
  });

  it("tests with the typed API key, saves the endpoint and sends the secret only to the keychain", async () => {
    vi.mocked(elasticTest).mockResolvedValueOnce({ version: "8.15.0", clusterName: "logs", health: "green", indices: 4 });
    render(ElasticPreferences);
    await fireEvent.click(screen.getByRole("radio", { name: "External" }));
    await fireEvent.input(screen.getByLabelText("Elasticsearch URL"), { target: { value: " https://es.example:9243 " } });
    await fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "api-key" } });
    await fireEvent.input(screen.getByLabelText("API key"), { target: { value: "s3cret" } });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Elasticsearch 8.15.0 · logs · health green · 4 matching");
    const [, , endpoint, auth] = vi.mocked(elasticTest).mock.calls[0]!;
    expect(endpoint.target).toEqual({ kind: "external", url: "https://es.example:9243" });
    expect(auth).toEqual({ method: "api-key", key: "s3cret" });

    vi.mocked(elasticAuthMethod).mockResolvedValue("api-key");
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(elastic.endpointFor("prod")?.target).toEqual({ kind: "external", url: "https://es.example:9243" }));
    expect(elasticSaveAuth).toHaveBeenCalledWith("prod", expect.objectContaining({ indexPattern: "logs-*,filebeat-*,logstash-*" }), {
      method: "api-key",
      key: "s3cret",
    });
    const stored = JSON.stringify(window.localStorage);
    expect(stored).not.toContain("s3cret");
    expect(await screen.findByText("saved in the keychain: api-key")).toBeInTheDocument();
  });

  it("shows a failed test as an alert", async () => {
    vi.mocked(elasticTest).mockRejectedValueOnce("Cannot reach Elasticsearch: no ready pod behind logging/es");
    await chooseInCluster();
    await fireEvent.input(screen.getByLabelText("Namespace"), { target: { value: "logging" } });
    await fireEvent.input(screen.getByLabelText("Service"), { target: { value: "es" } });
    await fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no ready pod");
  });

  it("uses ECK credentials for an in-cluster endpoint", async () => {
    await chooseInCluster();
    await fireEvent.input(screen.getByLabelText("Namespace"), { target: { value: "logging" } });
    await fireEvent.input(screen.getByLabelText("Service"), { target: { value: "quickstart-es-http" } });
    await fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "eck-user" } });
    await fireEvent.click(screen.getByRole("button", { name: "Use ECK credentials" }));
    await waitFor(() => expect(elasticUseEckCredentials).toHaveBeenCalled());
    expect(elastic.endpointFor("prod")?.target).toMatchObject({ kind: "in-cluster", service: "quickstart-es-http" });
  });

  it("turning it off removes the endpoint", async () => {
    elastic.setEndpoint("prod", {
      target: { kind: "external", url: "https://es.example" },
      indexPattern: "logs-*",
      preset: "ecs",
      kibanaUrl: null,
      skipTlsVerify: false,
    });
    render(ElasticPreferences);
    expect(await screen.findByText("current: https://es.example")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(elastic.endpointFor("prod")).toBeNull());
  });
});
