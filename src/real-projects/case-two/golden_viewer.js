// Browser handler for the coverage HTML execution-context explorer.
coverage.expand_contexts = function (event) {
    const span = event.target.parentNode.querySelector(".ctxs");
    if (span.classList.contains("expanded")) return;
    const payload = span.textContent;
    const width = Number(payload[0]);
    span.textContent = "";
    for (let i = 1; i < payload.length; i += width) {
        const code = payload.slice(i, i + width).trimEnd();
        span.appendChild(document.createTextNode(contexts[code]));
        span.appendChild(document.createElement("br"));
    }
    span.classList.add("expanded");
};
