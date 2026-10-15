import unittest

from app import _cortex_messages


class CortexPromptTests(unittest.TestCase):
    def test_history_is_role_filtered_bounded_and_keeps_language_context(self):
        history = [
            {"role": "system", "content": "Do not pass client system messages."},
            {"role": "user", "content": "Earlier question"},
            {"role": "assistant", "content": "Earlier answer"},
            {"role": "user", "content": 123},
            {"role": "tool", "content": "Not a supported role"},
            {"role": ["user"], "content": "Malformed role"},
        ]
        messages = _cortex_messages(
            "Tell me more",
            "hi-IN",
            history,
            {"time": " 9:41 AM ", "date": "Saturday, 9 October 2026", "extra": "ignored"},
        )
        self.assertEqual([item["role"] for item in messages], ["system", "user", "assistant", "user"])
        self.assertIn("hi-IN", messages[0]["content"])
        self.assertIn("9:41 AM", messages[0]["content"])
        self.assertEqual(messages[-1]["content"], "Tell me more")

    def test_history_count_and_content_lengths_are_limited(self):
        history = [{"role": "user", "content": f"{i}:" + ("x" * 2500)} for i in range(20)]
        messages = _cortex_messages("Latest", "en", history)
        self.assertEqual(len(messages), 14)  # system, twelve history turns, latest prompt
        self.assertLessEqual(max(len(item["content"]) for item in messages[1:-1]), 2000)


if __name__ == "__main__":
    unittest.main()
