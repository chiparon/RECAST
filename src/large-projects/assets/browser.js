"use strict";
// Used by the public browser fixtures. jQuery and all event/selector APIs are
// real. Only Select2's network/configuration boundary is captured by the test.
const $ = django.jQuery;
function element(id, tag = "input", parent = document.body) {
    const n = document.createElement(tag);
    n.id = id;
    parent.appendChild(n);
    return n;
}
$.fn.select2 = function(options) {
    return this.each(function() {this.selectConfig = options;});
};
