import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../src/client/modelconfig";

function load(src: string): ModelConfig {
  return yaml.load(src) as ModelConfig;
}

describe("ModelConfig", () => {
  it("parses a vllm config", () => {
    // From truss-examples/vllm/config.yaml
    const cfg = load(`
model_name: "Llama 3.1 8B Instruct VLLM openai compatible"
python_version: py311
model_metadata:
  example_model_input: {"prompt": "what is the meaning of life"}
  repo_id: meta-llama/Llama-3.1-8B-Instruct
  openai_compatible: true
requirements:
  - vllm==0.5.4
resources:
  accelerator: A100
  use_gpu: true
runtime:
  predict_concurrency: 128
secrets:
  hf_access_token: null
`);
    expect(cfg.model_name).toBe("Llama 3.1 8B Instruct VLLM openai compatible");
    expect(cfg.python_version).toBe("py311");
    expect(cfg.requirements).toEqual(["vllm==0.5.4"]);
    expect(cfg.resources?.accelerator).toBe("A100");
    expect(cfg.runtime?.predict_concurrency).toBe(128);
    expect(cfg.secrets).toBeDefined();
    expect("hf_access_token" in cfg.secrets!).toBe(true);
    expect(cfg.secrets!.hf_access_token).toBeNull();
  });

  it("parses a whisper config", () => {
    // From truss-examples/07-high-performance-dynamic-batching/config.yaml
    const cfg = load(`
base_image:
  image: baseten/trtllm-server:r23.12_baseten_v0.9.0.dev2024022000
  python_executable_path: /usr/bin/python3
model_name: TRT Whisper - Dynamic Batching
python_version: py311
model_cache:
  - repo_id: baseten/trtllm-whisper-a10g-large-v2-1
    revision: main
    use_volume: true
    volume_folder: trtllm-whisper-a10g-large-v2-1
resources:
  accelerator: A10G
runtime:
  predict_concurrency: 256
external_data:
  - local_data_path: assets/multilingual.tiktoken
    url: https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/multilingual.tiktoken
`);
    expect(cfg.model_name).toBe("TRT Whisper - Dynamic Batching");
    expect(cfg.base_image?.image).toBe("baseten/trtllm-server:r23.12_baseten_v0.9.0.dev2024022000");
    expect(cfg.model_cache).toHaveLength(1);
    expect(cfg.model_cache?.[0]?.repo_id).toBe("baseten/trtllm-whisper-a10g-large-v2-1");
    expect(cfg.model_cache?.[0]?.use_volume).toBe(true);
    expect(cfg.external_data).toHaveLength(1);
    expect(cfg.external_data?.[0]?.local_data_path).toBe("assets/multilingual.tiktoken");
  });

  it("parses a chatterbox config", () => {
    // From truss-examples/chatterbox-tts/config.yaml
    const cfg = load(`
model_name: Chatterbox TTS
base_image:
  image: jojobaseten/truss-numpy-1.26.0-gpu:0.4
  python_executable_path: /usr/bin/python3
python_version: py312
requirements:
  - chatterbox-tts
resources:
  accelerator: H100
  cpu: '1'
  memory: 40Gi
  use_gpu: true
`);
    expect(cfg.model_name).toBe("Chatterbox TTS");
    expect(cfg.python_version).toBe("py312");
    expect(cfg.resources?.accelerator).toBe("H100");
    expect(cfg.resources?.cpu).toBe("1");
    expect(cfg.resources?.memory).toBe("40Gi");
  });

  it("round-trips secrets null placeholder through JSON", () => {
    const cfg = JSON.parse(`{
      "secrets": {
        "placeholder": null,
        "explicit": "actual-value"
      }
    }`) as ModelConfig;
    expect(cfg.secrets).toBeDefined();
    expect(cfg.secrets!.placeholder).toBeNull();
    expect(cfg.secrets!.explicit).toBe("actual-value");
    expect("missing" in cfg.secrets!).toBe(false);

    const encoded = JSON.parse(JSON.stringify(cfg.secrets));
    expect(encoded.placeholder).toBeNull();
    expect(encoded.explicit).toBe("actual-value");
  });
});
