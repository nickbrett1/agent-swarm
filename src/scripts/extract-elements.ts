export const EXTRACT_ELEMENTS_SCRIPT = `
(() => {
  function getXPath(element) {
    if (element.id) {
      return \`//*[@id="\${element.id}"]\`;
    }
    const paths = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let hasSiblingWithSameTag = false;

      let prevSibling = current.previousSibling;
      while (prevSibling) {
        if (prevSibling.nodeType !== Node.DOCUMENT_TYPE_NODE && prevSibling.nodeName === current.nodeName) {
          index++;
          hasSiblingWithSameTag = true;
        }
        prevSibling = prevSibling.previousSibling;
      }

      let nextSibling = current.nextSibling;
      while (nextSibling) {
        if (nextSibling.nodeName === current.nodeName) {
          hasSiblingWithSameTag = true;
          break;
        }
        nextSibling = nextSibling.nextSibling;
      }

      const tagName = current.nodeName.toLowerCase();
      const pathIndex = hasSiblingWithSameTag ? \`[\${index + 1}]\` : "";
      paths.unshift(tagName + pathIndex);
      current = current.parentNode;
    }
    return paths.length ? "/" + paths.join("/") : "";
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function isDisabled(el) {
    if ('disabled' in el && el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.classList.contains("disabled")) return true;
    return false;
  }

  function getCleanText(el) {
    let text = (el.innerText || el.textContent || "").trim();
    if (!text && el.tagName === "INPUT") {
      text = el.value || "";
    }
    if (text.length > 80) {
      text = text.substring(0, 77) + "...";
    }
    return text;
  }

  function extractElementData(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      text: getCleanText(el),
      placeholder: el.placeholder || el.getAttribute("aria-label") || "",
      name: el.getAttribute("name") || el.getAttribute("id") || "",
      role: el.getAttribute("role") || "",
      xpath: getXPath(el)
    };
  }

  const results = [];
  const selector = 'button, a, input, select, textarea, [role="button"], [onclick]';
  const nodes = document.querySelectorAll(selector);

  nodes.forEach((node) => {
    const el = node;
    if (!isVisible(el) || isDisabled(el)) return;
    results.push(extractElementData(el));
  });

  return results;
})();
`;
