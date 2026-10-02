"""Build a credential-free Shortcuts signing probe (replaced by the uploader after signing validation)."""

import plistlib
from pathlib import Path

out = Path(".wrangler/shortcuts")
out.mkdir(parents=True, exist_ok=True)
workflow = {
    "WFWorkflowName": "Temporary Drop signing probe",
    "WFWorkflowClientVersion": "2700.0.4",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": 61440, "WFWorkflowIconStartColor": 431817727},
    "WFWorkflowTypes": [],
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
    "WFWorkflowActions": [{
        "WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
        "WFWorkflowActionParameters": {"WFTextActionText": "Temporary Drop signing probe. No credentials."},
    }],
}
(out / "Temporary-Drop.unsigned.plist").write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
print("Built credential-free signing probe")
