import base64
import io
import json
import unittest
from unittest.mock import patch

import server


PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nmock-image").decode()


class ServerTests(unittest.TestCase):
    def test_payload_and_request_do_not_include_answer(self):
        model, image = server.validate_payload({"model": "gpt-5.6-luna", "image": PNG})
        body = server.build_openai_body(model, image)
        self.assertEqual(body["store"], False)
        self.assertEqual(body["input"][0]["content"][1]["image_url"], PNG)
        self.assertNotIn("truth", json.dumps(body))
        self.assertNotIn("猫", json.dumps(body, ensure_ascii=False))
        self.assertEqual(body["text"]["format"]["type"], "json_schema")

    def test_rejects_invalid_input(self):
        with self.assertRaises(ValueError):
            server.validate_payload({"model": "unknown", "image": PNG})
        with self.assertRaises(ValueError):
            server.validate_payload({"model": "gpt-5.6-luna", "image": "data:image/png;base64,YWJj"})

    def test_parses_structured_response(self):
        raw = {"status": "completed", "model": "gpt-5.6-luna", "id": "resp_123", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": '{"label":"猫","evidence":"尖耳和胡须","unknown":false}'}]}
        ]}
        answer = server.parse_openai_response(raw)
        self.assertEqual(answer["label"], "猫")
        self.assertEqual(answer["response_id"], "resp_123")
        with self.assertRaises(ValueError):
            server.parse_openai_response({"status": "incomplete", "output": []})

    def test_proxy_does_not_log_or_return_key(self):
        raw = {"status": "completed", "model": "gpt-5.6-luna", "id": "resp_123", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": '{"label":"猫","evidence":"尖耳","unknown":false}'}]}
        ]}
        class FakeResponse(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *_): return None
        with patch("server.urllib.request.urlopen", return_value=FakeResponse(json.dumps(raw).encode())) as request:
            answer = server.call_openai("gpt-5.6-luna", PNG, "secret-test-key")
            self.assertNotIn("secret-test-key", json.dumps(answer))
            sent = request.call_args[0][0]
            self.assertEqual(sent.get_header("Authorization"), "Bearer secret-test-key")
            self.assertNotIn(b"secret-test-key", sent.data)


if __name__ == "__main__":
    unittest.main()
