"""Mock-model ID response authored from explicit fixture quote choices only."""
import json

def selection_reply(prompt, response):
    data = json.loads(prompt.split("\n", 1)[1])
    if "source_candidates" not in data:
        return response
    parsed = json.loads(response)
    if "source_quotes" not in parsed:
        return response
    quotes = parsed.pop("source_quotes")
    parsed["source_ids"] = [next((item[0] for item in data["source_candidates"]
        if item[1] == quote), "E99_0000000000000000") for quote in quotes]
    return json.dumps(parsed, ensure_ascii=False)
