# Order plugin bridge

Expose a stable port for a new order plugin. Validation, inventory reservation
and audit writing form one logical operation: incomplete input or a failed
reservation must leave the order state unchanged. Repeated requests must not
reserve inventory twice, and the plugin must depend on ports rather than a
concrete infrastructure implementation.
