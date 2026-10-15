import json
import re
import unittest
from pathlib import Path


CATALOG_PATH = Path(__file__).resolve().parents[1] / "static" / "language-catalog.json"


class LanguageCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.languages = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))

    def test_catalog_has_many_language_and_region_presets(self):
        self.assertGreaterEqual(len(self.languages), 170)

    def test_catalog_codes_are_unique_and_well_formed(self):
        codes = [language["code"] for language in self.languages]
        self.assertEqual(len(codes), len(set(codes)))
        for code in codes:
            self.assertRegex(code, r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$")

    def test_catalog_includes_primary_supported_languages(self):
        codes = {language["code"] for language in self.languages}
        self.assertTrue({"en", "es", "fr", "de", "ja"}.issubset(codes))


if __name__ == "__main__":
    unittest.main()
