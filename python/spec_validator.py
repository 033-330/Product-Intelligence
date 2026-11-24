import json
import re
import unittest

SOURCE_PRIORITY = {
    "official_product": 100,
    "official_technical": 95,
    "official_support": 90,
    "official_pdf": 85,
    "third_party": 50,
}

RANGES = {
    "weight_g": (20, 300),
    "max_dpi": (100, 50000),
    "max_tracking_speed_ips": (50, 2000),
    "max_acceleration_g": (1, 200),
    "polling_rate_hz": (125, 16000),
    "battery_life_hours": (1, 500),
    "dimensions_length_mm": (40, 250),
    "dimensions_width_mm": (20, 150),
    "dimensions_height_mm": (10, 100),
}


def normalize_alias(value):
    text = str(value or "").lower()
    text = re.sub(r"[\s\-_·.,;:!?'\n\r\t()\[\]/\\]+", "", text)
    return text


def parse_number(raw_value):
    text = str(raw_value if raw_value is not None else "").replace(",", "").strip()
    if not text or text.lower() in {"n/a", "na", "none", "null", "unknown", "-", "—"}:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def detect_unit(raw_value, definition):
    text = str(raw_value or "").lower()
    rule = str(definition.get("normalization_rule") or "")
    canonical = str(definition.get("canonical_unit") or "").lower()
    if rule == "convert_to_grams" or canonical == "g":
        if re.search(r"\bkg\b|kilogram", text):
            return "kg"
        if re.search(r"\bg\b|gram", text) or "克" in text:
            return "g"
    if rule == "convert_to_mm" or canonical == "mm":
        if re.search(r"\bmm\b|millimeter", text) or "毫米" in text:
            return "mm"
        if re.search(r"\bcm\b|centimeter", text) or "厘米" in text:
            return "cm"
        if re.search(r"\binch(?:es)?\b|\bin\b", text) or "英寸" in text:
            return "in"
    if canonical == "dpi" and re.search(r"\bdpi\b|\bcpi\b", text):
        return "DPI"
    if canonical == "ips" and re.search(r"\bips\b|inch(?:es)?\s*/\s*s", text):
        return "IPS"
    if canonical == "hz":
        if re.search(r"\bkhz\b", text):
            return "kHz"
        if re.search(r"\bhz\b", text):
            return "Hz"
    if canonical == "hours":
        if re.search(r"\bhours?\b|\bhrs?\b", text) or "小时" in text:
            return "hours"
        if re.search(r"\bh\b", text):
            return "h"
    return ""


def convert_unit(value, unit, canonical_unit):
    u = str(unit or "").lower().strip()
    c = str(canonical_unit or "").lower().strip()
    if not u:
        u = c
    if (not c and not u) or u == c:
        return True, value, str(canonical_unit or u)
    if c == "g":
        if u in {"g", "gram", "grams", "克"}:
            return True, value, "g"
        if u in {"kg", "kilogram", "kilograms", "千克"}:
            return True, value * 1000, "g"
    if c == "mm":
        if u in {"mm", "millimeter", "millimeters", "毫米"}:
            return True, value, "mm"
        if u in {"cm", "centimeter", "centimeters", "厘米"}:
            return True, value * 10, "mm"
        if u in {"in", "inch", "inches", "英寸"}:
            return True, value * 25.4, "mm"
    if c == "dpi" and u in {"dpi", "cpi"}:
        return True, value, "DPI"
    if c == "ips" and u in {"ips", "in/s", "inch/s", "inches/s"}:
        return True, value, "IPS"
    if c == "hz":
        if u == "hz":
            return True, value, "Hz"
        if u == "khz":
            return True, value * 1000, "Hz"
    if c == "hours" and u in {"h", "hr", "hrs", "hour", "hours", "小时"}:
        return True, value, "hours"
    return False, None, "unit_mismatch:" + u + "->" + c


def normalize_spec(spec, definition):
    raw = spec.get("raw_value")
    if raw is None or str(raw) == "":
        raw = spec.get("normalized_value")
    raw_text = str(raw if raw is not None else "").strip()
    if not raw_text:
        return False, None, "", "empty_value"
    if str(definition.get("data_type") or "").lower() == "string":
        return True, raw_text, "", ""
    number = parse_number(raw_text)
    if number is None:
        return False, None, "", "non_numeric"
    unit = str(spec.get("normalized_unit") or detect_unit(raw_text, definition) or definition.get("canonical_unit") or "").strip()
    ok, value, out_unit = convert_unit(number, unit, str(definition.get("canonical_unit") or ""))
    if not ok:
        return False, None, "", out_unit
    return True, value, out_unit, ""


def evidence_supported(evidence_text, source_text):
    evidence = normalize_alias(evidence_text)[:600]
    source = normalize_alias(source_text)
    return bool(evidence) and evidence in source


def range_warning(canonical_field, value):
    bounds = RANGES.get(canonical_field)
    if not bounds or not isinstance(value, (int, float)):
        return ""
    if value < bounds[0] or value > bounds[1]:
        return "suspicious_range:" + canonical_field + "=" + str(value)
    return ""


def validate_product_specifications(product, extracted, definitions, existing_observations=None):
    source_content = extracted.get("source_content") or {}
    identity_ok = source_content.get("verification", {}).get("status") == "verified"
    warnings = [str(w) for w in extracted.get("extraction_warnings") or []]
    if not identity_ok:
        warnings.append("identity_rejected:source_not_verified")
    definition_by_field = {str(d.get("canonical_field")): d for d in definitions}
    accepted = []
    rejected = []
    observations = []
    fetched_at = source_content.get("fetched_at") or extracted.get("extracted_at") or ""
    content_hash = source_content.get("content_hash") or ""

    for spec in extracted.get("specifications") or []:
        field = str(spec.get("canonical_field") or "").strip()
        definition = definition_by_field.get(field)
        evidence = str(spec.get("evidence_text") or "")
        source_url = str(spec.get("source_url") or source_content.get("source_url") or "")
        reason = ""
        normalized_ok = False
        normalized_value = None
        normalized_unit = str(spec.get("normalized_unit") or "")
        if not identity_ok:
            reason = "source_not_verified"
        elif not definition:
            reason = "unknown_field"
        elif not evidence.strip():
            reason = "missing_evidence"
        elif not evidence_supported(evidence, source_content.get("text") or ""):
            reason = "evidence_not_in_source"
        elif source_url and source_content.get("source_url") and source_url != source_content.get("source_url"):
            reason = "source_url_mismatch"
        else:
            normalized_ok, normalized_value, normalized_unit, reason = normalize_spec(spec, definition)
            if normalized_ok and float(spec.get("confidence") or 0) < 0.5:
                reason = "low_confidence"
        extracted_value = json.dumps({
            "normalized_value": normalized_value if normalized_ok and not reason else "",
            "normalized_unit": normalized_unit,
            "confidence": float(spec.get("confidence") or 0),
        }, ensure_ascii=False)
        source_type = str(source_content.get("source_type") or "third_party")
        observation = {
            "raw_id": "SPIRAW-" + str(abs(hash((product.get("product_id"), field, source_url, spec.get("raw_value"), evidence, content_hash)))),
            "product_id": str(product.get("product_id") or ""),
            "canonical_field": field,
            "raw_field_name": str(spec.get("raw_field_name") or ""),
            "raw_value": str(spec.get("raw_value") or ""),
            "extracted_value": extracted_value,
            "source_url": source_url,
            "source_title": str(source_content.get("source_title") or ""),
            "source_type": source_type,
            "evidence_text": evidence,
            "extraction_method": str(extracted.get("extraction_method") or "gemini_flash_evidence_prompt_v1"),
            "model_version": str(extracted.get("model_version") or "v1"),
            "fetched_at": fetched_at,
            "verification_status": "rejected" if reason else "accepted",
            "rejection_reason": reason,
            "content_hash": content_hash,
            "source_priority": SOURCE_PRIORITY.get(source_type, 0),
        }
        observations.append(observation)
        if reason:
            rejected.append({"canonical_field": field, "reason": reason, "raw_value": observation["raw_value"]})
            continue
        warning = range_warning(field, normalized_value)
        if warning:
            warnings.append(warning)
        accepted.append({
            "product_id": str(product.get("product_id") or ""),
            "canonical_field": field,
            "normalized_value": normalized_value,
            "normalized_unit": normalized_unit,
            "selected_source_url": source_url,
            "source_type": source_type,
            "source_priority": SOURCE_PRIORITY.get(source_type, 0),
            "evidence_text": evidence,
            "verification_status": "verified_by_evidence",
            "confidence": float(spec.get("confidence") or 0),
            "last_verified_at": fetched_at,
            "raw_id": observation["raw_id"],
            "fetched_at": fetched_at,
            "warnings": [warning] if warning else [],
        })

    current_raw_ids = {str(o.get("raw_id") or "") for o in observations}
    prior_accepted = []
    for row in existing_observations or []:
        if str(row.get("product_id") or "") != str(product.get("product_id") or ""):
            continue
        if str(row.get("verification_status") or "") != "accepted":
            continue
        if str(row.get("raw_id") or "") in current_raw_ids:
            continue
        try:
            parsed = json.loads(str(row.get("extracted_value") or "{}"))
        except Exception:
            parsed = {}
        if parsed.get("normalized_value") in (None, ""):
            continue
        source_type = str(row.get("source_type") or "third_party")
        prior_accepted.append({
            "product_id": str(product.get("product_id") or ""),
            "canonical_field": str(row.get("canonical_field") or ""),
            "normalized_value": parsed.get("normalized_value"),
            "normalized_unit": str(parsed.get("normalized_unit") or ""),
            "selected_source_url": str(row.get("source_url") or ""),
            "source_type": source_type,
            "source_priority": SOURCE_PRIORITY.get(source_type, 0),
            "evidence_text": str(row.get("evidence_text") or ""),
            "verification_status": "verified_by_evidence",
            "confidence": float(parsed.get("confidence") or 0.5),
            "last_verified_at": str(row.get("fetched_at") or ""),
            "raw_id": str(row.get("raw_id") or ""),
            "fetched_at": str(row.get("fetched_at") or ""),
            "warnings": [],
        })

    conflicts = []
    selected_winners = []
    by_field = {}
    for item in accepted + prior_accepted:
        by_field.setdefault(item["canonical_field"], []).append(item)
    for field, items in by_field.items():
        items.sort(key=lambda i: (i["source_priority"], i["fetched_at"]), reverse=True)
        selected_winners.append(items[0])
        if len(items) < 2:
            continue
        values = {str(i["normalized_value"]) + "|" + str(i["normalized_unit"]) for i in items}
        if len(values) < 2:
            continue
        unresolved = items[0]["source_priority"] == items[1]["source_priority"]
        if unresolved:
            selected_winners = [i for i in selected_winners if i["canonical_field"] != field]
        conflicts.append({
            "canonical_field": field,
            "unresolved": unresolved,
            "selected_source_url": "" if unresolved else items[0]["selected_source_url"],
            "resolved_by": "" if unresolved else ("source_priority" if items[0]["source_priority"] > items[1]["source_priority"] else "newer_verified_source"),
            "observations": items,
        })

    accepted_fields = {item["canonical_field"] for item in selected_winners}
    missing_fields = [str(d.get("canonical_field")) for d in definitions if str(d.get("canonical_field")) not in accepted_fields]
    for field in extracted.get("missing_fields") or []:
        field = str(field)
        if field in {str(d.get("canonical_field")) for d in definitions} and field not in missing_fields:
            missing_fields.append(field)

    return {
        "product_id": str(product.get("product_id") or ""),
        "status": "validated" if identity_ok else "identity_rejected",
        "accepted": accepted,
        "selected_winners": selected_winners,
        "rejected": rejected,
        "conflicts": conflicts,
        "warnings": warnings,
        "missing_fields": missing_fields,
        "raw_observations": observations,
    }


DEFINITIONS = [
    {"canonical_field": "weight_g", "data_type": "number", "canonical_unit": "g", "normalization_rule": "convert_to_grams"},
    {"canonical_field": "polling_rate_hz", "data_type": "number", "canonical_unit": "Hz", "normalization_rule": "normalize_hz"},
    {"canonical_field": "sensor_name", "data_type": "string", "canonical_unit": "", "normalization_rule": "trim"},
]

PRODUCT = {"product_id": "P001", "canonical_name": "GPW5 Ultra", "brand": "Logitech", "category": "mouse"}


def source(content, priority_type="official_product"):
    return {
        "source_url": "https://www.logitechg.com/en-us/products/gaming-mice.html",
        "source_title": "Official specs",
        "source_type": priority_type,
        "text": content,
        "content_hash": "abc123",
        "fetched_at": "2026-11-23T00:00:00.000Z",
        "verification": {"status": "verified"},
    }


class SpecValidatorTests(unittest.TestCase):
    def test_normalize_weight_and_string(self):
        ok, value, unit, reason = normalize_spec({"raw_value": "Approx. 60 grams", "normalized_unit": ""}, DEFINITIONS[0])
        self.assertTrue(ok)
        self.assertEqual(value, 60)
        self.assertEqual(unit, "g")
        self.assertEqual(reason, "")
        ok, value, unit, reason = normalize_spec({"raw_value": "HERO 2", "normalized_unit": ""}, DEFINITIONS[2])
        self.assertTrue(ok)
        self.assertEqual(value, "HERO 2")

    def test_evidence_required(self):
        extracted = {
            "source_content": source("Weight: Approx. 60 grams"),
            "specifications": [
                {"canonical_field": "weight_g", "raw_field_name": "Weight", "raw_value": "Approx. 60 grams", "evidence_text": "not on page", "confidence": 0.99},
            ],
            "missing_fields": [],
            "extraction_warnings": [],
        }
        result = validate_product_specifications(PRODUCT, extracted, DEFINITIONS)
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["rejected"][0]["reason"], "evidence_not_in_source")

    def test_conflict_resolution_official_over_third_party(self):
        extracted = {
            "source_content": source("Weight: 60 g"),
            "specifications": [
                {"canonical_field": "weight_g", "raw_field_name": "Weight", "raw_value": "60 g", "evidence_text": "Weight: 60 g", "confidence": 0.9},
            ],
            "missing_fields": [],
            "extraction_warnings": [],
        }
        existing = [{
            "raw_id": "old-third-party",
            "product_id": "P001",
            "canonical_field": "weight_g",
            "verification_status": "accepted",
            "extracted_value": json.dumps({"normalized_value": 63, "normalized_unit": "g", "confidence": 0.9}),
            "source_url": "https://example.com/review",
            "source_type": "third_party",
            "evidence_text": "Weight: 63 g",
            "fetched_at": "2026-11-22T00:00:00.000Z",
        }]
        result = validate_product_specifications(PRODUCT, extracted, DEFINITIONS, existing)
        self.assertEqual(len(result["accepted"]), 1)
        self.assertEqual(len(result["conflicts"]), 1)
        self.assertEqual(result["conflicts"][0]["resolved_by"], "source_priority")
        self.assertEqual(result["conflicts"][0]["selected_source_url"], extracted["source_content"]["source_url"])
        self.assertEqual(result["selected_winners"][0]["normalized_value"], 60)

    def test_zero_is_not_missing(self):
        extracted = {
            "source_content": source("Polling Rate: 0 Hz"),
            "specifications": [
                {"canonical_field": "polling_rate_hz", "raw_field_name": "Polling Rate", "raw_value": "0 Hz", "evidence_text": "Polling Rate: 0 Hz", "confidence": 0.9},
            ],
            "missing_fields": [],
            "extraction_warnings": [],
        }
        result = validate_product_specifications(PRODUCT, extracted, DEFINITIONS)
        self.assertEqual(result["accepted"][0]["normalized_value"], 0)
        self.assertNotIn("polling_rate_hz", result["missing_fields"])
        self.assertTrue(any("suspicious_range" in w for w in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
