"""A tiny, dependency-free conversational engine for PyBoT.

The assistant is intentionally local and rules-based. Keep intent handling small,
explicit, and safe rather than evaluating user input as Python code.
"""

from __future__ import annotations

import ast
import json
import math
import operator
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping


_ROOT = Path(__file__).resolve().parent
_LOCALE_DIR = _ROOT / "static" / "locales"

_DEFAULT_REPLIES = {
    "response.greeting": "Hello! I'm PyBoT. What would you like to work on?",
    "response.time": "It's {time} where you are.",
    "response.date": "Today is {date}.",
    "response.calculate": "That comes to {result}.",
    "response.help": (
        "I can tell you the local time and date, solve quick calculations, and take "
        "voice-dictated messages. I work as a lightweight local assistant, so no AI account is required."
    ),
    "response.identity": (
        "I'm PyBoT, your personal assistant. I'm running in local mode, with no external AI service connected."
    ),
    "response.joke": "Why did the computer get cold? It left its Windows open.",
    "response.mathError": "I couldn't safely evaluate that expression. Try a simple calculation such as 248 × 17.",
    "response.unknown": (
        "I'm in local assistant mode, so I can't answer open-ended questions just yet. "
        "I can help with the time, date, and calculations. Ask “What can you do?” for a quick guide."
    ),
}

_BUILTIN_REPLIES: dict[str, dict[str, str]] = {}
for _locale_file in _LOCALE_DIR.glob("*.json"):
    try:
        _payload = json.loads(_locale_file.read_text(encoding="utf-8"))
        _BUILTIN_REPLIES[_locale_file.stem.lower()] = {
            key: value
            for key, value in _payload.items()
            if key.startswith("response.") and isinstance(value, str)
        }
    except (OSError, json.JSONDecodeError):
        continue


_TIME_PATTERNS = {
    "en": re.compile(r"\b(?:what time(?: is it)?|what(?:'s| is) the time|current time|time now|tell me the time|clock|time)\b", re.I),
    "es": re.compile(r"\b(?:qué hora|que hora|hora actual|dime la hora|reloj|hora)\b", re.I),
    "fr": re.compile(r"\b(?:quelle heure|heure actuelle|donne[- ]moi l'heure|horloge|heure)\b", re.I),
    "de": re.compile(r"\b(?:wie spät|wieviel uhr|wie viel uhr|uhrzeit|uhr)\b", re.I),
    "ja": re.compile(r"(?:何時|時刻|現在の時間|今の時間)"),
}
_DATE_PATTERNS = {
    "en": re.compile(r"\b(?:what(?:'s| is) (?:the )?date|today(?:'s)? date|what day is (?:it|today)|current date|date today)\b", re.I),
    "es": re.compile(r"\b(?:qué fecha|que fecha|fecha de hoy|qué día es hoy|que dia es hoy|fecha actual)\b", re.I),
    "fr": re.compile(r"\b(?:quelle date|date d'aujourd'hui|date du jour|quel jour sommes-nous)\b", re.I),
    "de": re.compile(r"\b(?:welches datum|heutiges datum|datum heute|welcher tag ist heute)\b", re.I),
    "ja": re.compile(r"(?:何日|今日の日付|日付|何曜日)"),
}
_GREETINGS = {
    "en": re.compile(r"\b(?:hi|hello|hey|good morning|good afternoon|good evening|howdy)\b", re.I),
    "es": re.compile(r"\b(?:hola|buenos días|buenas tardes|buenas noches)\b", re.I),
    "fr": re.compile(r"\b(?:bonjour|salut|bonsoir|coucou)\b", re.I),
    "de": re.compile(r"\b(?:hallo|guten morgen|guten tag|guten abend|servus)\b", re.I),
    "ja": re.compile(r"(?:こんにちは|おはよう|こんばんは|やあ|もしもし)"),
}
_HELP = {
    "en": re.compile(r"\b(?:help|what can you do|your capabilities|what are your features|how do you work)\b", re.I),
    "es": re.compile(r"\b(?:ayuda|qué puedes hacer|que puedes hacer|qué sabes hacer|como funcionas)\b", re.I),
    "fr": re.compile(r"\b(?:aide|que peux-tu faire|que savez-vous faire|comment fonctionnes-tu|tes capacités)\b", re.I),
    "de": re.compile(r"\b(?:hilfe|was kannst du|was kannst du tun|wie funktionierst du)\b", re.I),
    "ja": re.compile(r"(?:何ができますか|何ができる|使い方|機能|ヘルプ)"),
}
_IDENTITY = {
    "en": re.compile(r"\b(?:who are you|what are you|your name|what's your name)\b", re.I),
    "es": re.compile(r"\b(?:quién eres|quien eres|cómo te llamas|como te llamas)\b", re.I),
    "fr": re.compile(r"\b(?:qui es-tu|qui êtes-vous|comment tu t'appelles|ton nom)\b", re.I),
    "de": re.compile(r"\b(?:wer bist du|wie heißt du|was bist du)\b", re.I),
    "ja": re.compile(r"(?:あなたは誰|名前は|何者)"),
}
_JOKES = {
    "en": re.compile(r"\b(?:tell me a joke|make me laugh|say something funny|joke)\b", re.I),
    "es": re.compile(r"\b(?:cuéntame un chiste|cuentame un chiste|un chiste|hazme reír)\b", re.I),
    "fr": re.compile(r"\b(?:raconte-moi une blague|une blague|fais-moi rire)\b", re.I),
    "de": re.compile(r"\b(?:erzähl einen witz|erzaehl einen witz|ein witz|witz)\b", re.I),
    "ja": re.compile(r"(?:冗談|面白い話|笑わせて)"),
}

_MATH_COMMAND = re.compile(
    r"\b(?:calculate|compute|solve|evaluate|work out|calcula|calcule|calcular|"
    r"combien font|berechne|rechne|ausrechnen)\b|計算",
    re.I,
)
_MATH_OPERATORS = re.compile(r"[-+*/%×÷^]|\b(?:plus|minus|times|multiplied|divided|over|modulo|más|mas|menos|por|fois|moins|mal)\b", re.I)

_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPERATORS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


class CalculationError(ValueError):
    """Raised when an expression is invalid or outside the safe calculation bounds."""


def _base_language(language: Any) -> str:
    if not isinstance(language, str):
        return "en"
    value = language.split("-", 1)[0].strip().lower()
    return value if value in {"en", "es", "fr", "de", "ja"} else value or "en"


def _matches(patterns: Mapping[str, re.Pattern[str]], language: str, message: str) -> bool:
    pattern = patterns.get(language) or patterns.get("en")
    return bool(pattern.search(message)) if pattern else False


def _is_math_request(message: str) -> bool:
    normalized = unicodedata.normalize("NFKC", message).casefold()
    number_count = len(re.findall(r"\d+(?:\.\d+)?", normalized))
    explicit = bool(_MATH_COMMAND.search(normalized))
    has_operator = bool(_MATH_OPERATORS.search(normalized))
    return (explicit and number_count > 0) or (has_operator and number_count >= 2)


def _expression_from_message(message: str) -> str:
    expression = unicodedata.normalize("NFKC", message).casefold()
    expression = expression.replace("×", "*").replace("÷", "/")
    expression = re.sub(r"(?<=\d)\s*x\s*(?=[\d(])", "*", expression)
    expression = re.sub(r"\bmultiplied\s+by\b|\btimes\b|\bmal\b|\bfois\b|\bpor\b", "*", expression)
    expression = re.sub(r"\bdivided\s+by\b|\bdivided\b|\bgeteilt\s+durch\b|\bdivisé\s+par\b", "/", expression)
    expression = re.sub(r"\bplus\b|\bmas\b|\bmás\b", "+", expression)
    expression = re.sub(r"\bminus\b|\bmenos\b|\bmoins\b", "-", expression)
    expression = re.sub(r"\bmod(?:ulo)?\b", "%", expression)
    expression = re.sub(r"\bover\b", "/", expression)
    expression = re.sub(r"\b(?:calculate|compute|solve|evaluate|work out|what is|what's|whats|"
                        r"please|calcula|calcule|calcular|berechne|rechne|ausrechnen|"
                        r"cuánto es|cuanto es|combien font)\b", " ", expression)
    expression = re.sub(r"計算(?:してください|して|して下さい)?|を|してください|して下さい", " ", expression)
    expression = expression.replace("^", "**")
    expression = expression.strip().strip("=?.,! ")

    # Only allow a basic arithmetic alphabet into the parser; natural-language
    # leftovers (or code-like input) are rejected rather than guessed at.
    if not expression or len(expression) > 100 or not re.fullmatch(r"[0-9eE+\-*/(). %]*", expression):
        raise CalculationError("Expression contains unsupported text")
    return expression


def _safe_eval(node: ast.AST, depth: int = 0) -> int | float:
    if depth > 20:
        raise CalculationError("Expression is too deeply nested")
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body, depth + 1)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        value: int | float = node.value
    elif isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPERATORS:
        value = _UNARY_OPERATORS[type(node.op)](_safe_eval(node.operand, depth + 1))
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPERATORS:
        left = _safe_eval(node.left, depth + 1)
        right = _safe_eval(node.right, depth + 1)
        if isinstance(node.op, ast.Pow) and (abs(right) > 12 or abs(left) > 1e8):
            raise CalculationError("Exponent is outside the supported range")
        value = _BINARY_OPERATORS[type(node.op)](left, right)
    else:
        raise CalculationError("Unsupported arithmetic expression")

    if not math.isfinite(float(value)) or abs(value) > 1e24:
        raise CalculationError("Result is outside the supported range")
    return value


def _calculate(message: str) -> str:
    expression = _expression_from_message(message)
    tree = ast.parse(expression, mode="eval")
    nodes = list(ast.walk(tree))
    if len(nodes) > 48:
        raise CalculationError("Expression is too long")
    result = _safe_eval(tree)
    if isinstance(result, float) and result.is_integer():
        result = int(result)
    if isinstance(result, int):
        return str(result)
    return format(result, ".10g")


def _normalize_command_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    output: list[str] = []
    for character in normalized:
        if character in {"'", "’", "‘", "ʼ"}:
            continue
        output.append(" " if unicodedata.category(character)[0] in {"P", "S"} else character)
    return " ".join("".join(output).split())


def _match_custom_command(message: str, language: str, commands: Any) -> dict[str, str] | None:
    if not isinstance(language, str) or not isinstance(commands, list):
        return None
    target = _normalize_command_text(message)
    if not target:
        return None
    active_language = language.casefold()
    active_base = active_language.split("-", 1)[0]
    for command in commands[:50]:
        if not isinstance(command, Mapping):
            continue
        command_language = command.get("language")
        if not isinstance(command_language, str) or len(command_language) > 20:
            continue
        command_language = command_language.casefold()
        if command_language != active_language and command_language.split("-", 1)[0] != active_base:
            continue
        triggers = command.get("triggers")
        reply = command.get("reply")
        name = command.get("name", "Custom command")
        if not isinstance(triggers, list) or not isinstance(reply, str) or not reply.strip() or len(reply) > 1000:
            continue
        if not isinstance(name, str):
            name = "Custom command"
        for trigger in triggers[:12]:
            if isinstance(trigger, str) and len(trigger) <= 120 and _normalize_command_text(trigger) == target:
                return {"name": name[:80], "reply": reply}
    return None


def _clean_context_value(context: Any, key: str, fallback: str) -> str:
    if isinstance(context, Mapping):
        value = context.get(key)
        if isinstance(value, str):
            value = " ".join(value.split())
            if 0 < len(value) <= 80:
                return value
    return fallback


def _render(template: str, values: Mapping[str, str]) -> str:
    return re.sub(r"\{([a-zA-Z_]+)\}", lambda match: values.get(match.group(1), match.group(0)), template)


def _reply_template(key: str, language: str, translations: Any) -> str:
    # Browser language packs are allowed to provide only display text, never code.
    if isinstance(translations, Mapping):
        custom = translations.get(key)
        if isinstance(custom, str) and custom.strip() and len(custom) <= 2000:
            return custom
    localized = _BUILTIN_REPLIES.get(language, {}).get(key)
    return localized or _DEFAULT_REPLIES[key]


def respond(
    message: str,
    language: str = "en",
    context: Any = None,
    translations: Any = None,
    commands: Any = None,
) -> dict[str, str]:
    """Return a localized, rules-based reply for one user message.

    ``context`` may include browser-formatted ``time`` and ``date`` values so
    answers respect the user's own locale and timezone. ``translations`` is a
    flat UI language-pack mapping; only response text keys are ever consulted.
    ``commands`` contains inert, language-scoped phrase-to-text-reply rules; it
    is never interpreted as Python, shell, or operating-system instructions.
    """
    raw_message = message.strip()
    normalized = unicodedata.normalize("NFKC", raw_message).casefold()
    lang = _base_language(language)

    now = datetime.now().astimezone()
    fallback_time = now.strftime("%-I:%M %p") if lang == "en" else now.strftime("%H:%M")
    fallback_date = now.strftime("%A, %B %-d, %Y") if lang == "en" else now.strftime("%Y-%m-%d")
    local_time = _clean_context_value(context, "time", fallback_time)
    local_date = _clean_context_value(context, "date", fallback_date)
    custom_command = _match_custom_command(raw_message, language, commands)
    if custom_command:
        reply = _render(custom_command["reply"], {"time": local_time, "date": local_date})
        return {"reply": reply, "intent": "custom_command", "command": custom_command["name"]}

    intent: str
    values: dict[str, str] = {}
    if _matches(_TIME_PATTERNS, lang, normalized):
        intent = "time"
        values["time"] = local_time
    elif _matches(_DATE_PATTERNS, lang, normalized):
        intent = "date"
        values["date"] = local_date
    elif _is_math_request(raw_message):
        try:
            intent = "calculate"
            values["result"] = _calculate(raw_message)
        except (CalculationError, SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError):
            intent = "math_error"
            values = {}
    elif _matches(_GREETINGS, lang, normalized):
        intent = "greeting"
    elif _matches(_JOKES, lang, normalized):
        intent = "joke"
    elif _matches(_IDENTITY, lang, normalized):
        intent = "identity"
    elif _matches(_HELP, lang, normalized):
        intent = "help"
    else:
        intent = "unknown"

    reply_key = {
        "greeting": "response.greeting",
        "time": "response.time",
        "date": "response.date",
        "calculate": "response.calculate",
        "math_error": "response.mathError",
        "help": "response.help",
        "identity": "response.identity",
        "joke": "response.joke",
        "unknown": "response.unknown",
    }[intent]
    template = _reply_template(reply_key, lang, translations)
    return {"reply": _render(template, values), "intent": intent}
