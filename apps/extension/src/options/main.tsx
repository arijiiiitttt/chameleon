import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PRIVACY_POLICY, type PolicyAction, type PrivacyPolicy } from "@chameleon/shared-types";

const ACTIONS: PolicyAction[] = ["ALLOW", "MASK", "BLUR", "TOKENIZE", "BLOCK"];

function OptionsPage(): React.ReactElement {
  const [policy, setPolicy] = useState<PrivacyPolicy>(DEFAULT_PRIVACY_POLICY);
  const [saved, setSaved] = useState(false);

  function updateAction(category: keyof PrivacyPolicy, action: PolicyAction) {
    setPolicy((prev) => ({ ...prev, [category]: action }));
    setSaved(false);
  }

  async function save() {
    await chrome.storage.local.set({ privacyPolicy: policy });
    setSaved(true);
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 640 }}>
      <h1>🦎 CHAMELEON - Privacy Policy Settings</h1>
      <p>Configure how each sensitivity category is handled locally before any data leaves the device.</p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Category</th>
            <th style={{ textAlign: "left" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(policy) as Array<keyof PrivacyPolicy>).map((category) => (
            <tr key={category}>
              <td style={{ padding: "4px 8px" }}>{category}</td>
              <td>
                <select value={policy[category]} onChange={(e) => updateAction(category, e.target.value as PolicyAction)}>
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={save} style={{ marginTop: 16 }}>
        Save
      </button>
      {saved && <span style={{ marginLeft: 8, color: "green" }}>Saved</span>}
    </div>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(<OptionsPage />);
