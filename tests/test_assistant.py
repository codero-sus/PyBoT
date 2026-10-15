import unittest

from assistant import respond


class AssistantTests(unittest.TestCase):
    def test_greeting_uses_selected_reply_pack(self):
        result = respond("hello", "en")
        self.assertEqual(result["intent"], "greeting")
        self.assertIn("Hello", result["reply"])

    def test_arithmetic_symbols_are_evaluated(self):
        result = respond("Calculate 248 × 17", "en")
        self.assertEqual(result["intent"], "calculate")
        self.assertEqual(result["reply"], "That comes to 4216.")

    def test_arithmetic_words_and_subtraction_are_evaluated(self):
        addition = respond("What is 12 plus 3?", "en")
        subtraction = respond("What is 12 - 3?", "en")
        self.assertEqual(addition["intent"], "calculate")
        self.assertIn("15", addition["reply"])
        self.assertEqual(subtraction["intent"], "calculate")
        self.assertIn("9", subtraction["reply"])

    def test_calculator_rejects_code_and_division_by_zero(self):
        code = respond("calculate __import__('os').system(1 + 1)", "en")
        zero = respond("calculate 9 / 0", "en")
        self.assertEqual(code["intent"], "math_error")
        self.assertEqual(zero["intent"], "math_error")

    def test_large_exponents_are_bounded(self):
        result = respond("calculate 999999999 ^ 99", "en")
        self.assertEqual(result["intent"], "math_error")

    def test_browser_context_is_used_for_time_and_date(self):
        time = respond("What time is it?", "en", {"time": "9:41 AM", "date": "Saturday, October 3, 2026"})
        date = respond("What is today's date?", "en", {"time": "9:41 AM", "date": "Saturday, October 3, 2026"})
        self.assertEqual(time["intent"], "time")
        self.assertIn("9:41 AM", time["reply"])
        self.assertEqual(date["intent"], "date")
        self.assertIn("October 3, 2026", date["reply"])

    def test_built_in_languages_route_and_localize(self):
        spanish = respond("¿Qué hora es?", "es", {"time": "10:12"})
        japanese = respond("今何時ですか？", "ja", {"time": "10:12"})
        self.assertEqual(spanish["intent"], "time")
        self.assertIn("10:12", spanish["reply"])
        self.assertIn("10:12", japanese["reply"])
        self.assertTrue(spanish["reply"].startswith("En tu ubicación"))

    def test_custom_translation_pack_can_extend_replies(self):
        result = respond(
            "What can you do?",
            "it",
            translations={"response.help": "Posso aiutarti con l'ora e i calcoli."},
        )
        self.assertEqual(result["intent"], "help")
        self.assertEqual(result["reply"], "Posso aiutarti con l'ora e i calcoli.")

    def test_empty_custom_translation_falls_back_to_english(self):
        result = respond("hello", "it", translations={"response.greeting": ""})
        self.assertEqual(result["reply"], "Hello! I'm PyBoT. What would you like to work on?")

    def test_language_scoped_command_package_matches_phrases(self):
        commands = [{
            "language": "en",
            "name": "Dashboard shortcut",
            "triggers": ["open dashboard", "show my dashboard"],
            "reply": "Your dashboard is ready at {time}.",
        }]
        result = respond("OPEN DASHBOARD!", "en", {"time": "9:41 AM"}, commands=commands)
        self.assertEqual(result["intent"], "custom_command")
        self.assertEqual(result["command"], "Dashboard shortcut")
        self.assertEqual(result["reply"], "Your dashboard is ready at 9:41 AM.")

    def test_command_matching_ignores_apostrophes_and_region(self):
        commands = [{"language": "en", "name": "Weather shortcut", "triggers": ["what's the weather?"], "reply": "I don't have live weather data."}]
        result = respond("Whats the weather", "en-GB", commands=commands)
        self.assertEqual(result["intent"], "custom_command")
        self.assertEqual(result["reply"], "I don't have live weather data.")

    def test_command_package_does_not_run_for_another_language(self):
        commands = [{"language": "en", "name": "English shortcut", "triggers": ["hello there"], "reply": "Safe text only."}]
        result = respond("hello there", "es", commands=commands)
        self.assertEqual(result["intent"], "unknown")

    def test_custom_command_replies_are_text_not_executable_code(self):
        commands = [{
            "language": "en",
            "name": "Text demo",
            "triggers": ["show code"],
            "reply": "__import__('os').system('echo unsafe')",
        }]
        result = respond("show code", "en", commands=commands)
        self.assertEqual(result["reply"], "__import__('os').system('echo unsafe')")
        self.assertEqual(result["intent"], "custom_command")

    def test_unknown_prompt_is_transparent_about_local_mode(self):
        result = respond("What is the capital of France?", "en")
        self.assertEqual(result["intent"], "unknown")
        self.assertIn("local assistant mode", result["reply"])


if __name__ == "__main__":
    unittest.main()
