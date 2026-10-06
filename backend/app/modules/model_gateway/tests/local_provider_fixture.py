"""Prompt-free, synthetic provider declarations for existing HTTP fixtures."""
import json


def ollama_tags(*names):
    return {"models": [{"name": name + ":latest", "model": name + ":latest",
                        "size": 4096, "digest": "a" * 64, "details": {"format": "gguf"}}
                       for name in names]}


class LocalProviderMetadata:
    def do_GET(self):
        if self.path != "/api/tags":
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(ollama_tags("synthetic", "fixture", "image", "text", "replacement",
                                     "old-model", "new-model", "synthetic-fixture", "synthetic-text")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
