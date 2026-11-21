const setting = "geminiApiKey";
let storageReady;

function restrictStorage() {
  storageReady ??= chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error) => {
      storageReady = null;
      throw error;
    });
  return storageReady;
}

export async function getGeminiKey() {
  await restrictStorage();
  const stored = await chrome.storage.local.get(setting);
  return stored[setting] || "";
}

export function parseGeminiKeyFile(source) {
  const matches = [...source.matchAll(/^\s*(?:export[ \t]+)?GEMINI_API_KEY[ \t]*=[ \t]*([^\r\n]*)/gm)];
  const value = (matches.at(-1)?.[1] ?? "").trim();
  const quoted = /^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(value);
  return (quoted ? (quoted[1] ?? quoted[2]) : value.split("#", 1)[0]).trim();
}

export function setupKeySettings(onChange) {
  const button = document.getElementById("key-settings");
  const dialog = document.getElementById("settings");
  const form = document.getElementById("key-form");
  const field = document.getElementById("gemini-key");
  const fileField = document.getElementById("key-file");
  const status = document.getElementById("key-status");
  const save = document.getElementById("save-key");
  const remove = document.getElementById("remove-key");

  const feedback = (message, error = false) => {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("error", error);
  };
  const update = (hasKey) => {
    button.textContent = hasKey ? "Settings" : "Set Gemini key";
    field.placeholder = hasKey ? "Replace saved key" : "Enter your key";
    remove.hidden = !hasKey;
  };
  void getGeminiKey().then((key) => update(Boolean(key)), () => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && setting in changes) update(Boolean(changes[setting].newValue));
  });

  button.addEventListener("click", () => {
    if (!dialog.open) dialog.showModal();
  });
  document.getElementById("cancel-key").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    field.value = "";
    fileField.value = "";
    feedback("");
  });
  document.getElementById("import-key").addEventListener("click", () => fileField.click());
  fileField.addEventListener("change", async () => {
    const file = fileField.files?.[0];
    fileField.value = "";
    if (!file) return;
    try {
      if (file.size > 65_536) throw new Error("Choose the small .env.local file containing your key.");
      const value = parseGeminiKeyFile(await file.text());
      if (!value) throw new Error("This file has no GEMINI_API_KEY value.");
      if (!dialog.open) return;
      field.value = value;
      feedback("Key imported. Select Save key to use it.");
    } catch (error) {
      if (dialog.open) feedback(error.message, true);
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = field.value.trim();
    if (!/^[!-~]{10,256}$/.test(key)) {
      feedback("Enter your Gemini API key as a single line.", true);
      return;
    }
    save.disabled = true;
    try {
      await restrictStorage();
      await chrome.storage.local.set({ [setting]: key });
      update(true);
      dialog.close();
      onChange(true);
    } catch {
      feedback("Chrome could not save the key.", true);
    } finally {
      save.disabled = false;
    }
  });
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      await restrictStorage();
      await chrome.storage.local.remove(setting);
      update(false);
      dialog.close();
      onChange(false);
    } catch {
      feedback("Chrome could not remove the key.", true);
    } finally {
      remove.disabled = false;
    }
  });
}
