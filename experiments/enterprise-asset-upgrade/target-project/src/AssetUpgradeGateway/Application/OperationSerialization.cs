namespace AssetUpgradeGateway.Application;

using System.Text;

/// <summary>
/// Process-wide serialization for idempotent gateway operations.
///
/// The <see cref="AssetUpgradeGateway.IIdempotencyStore"/> port deliberately
/// exposes only a non-atomic HasCompleted/MarkCompleted pair, so two callers
/// racing on the same operation could both observe "not completed" and repeat a
/// side effect. Gateway entry points that must not repeat dispatch, reservation
/// or commit under concurrency take a gate around the whole
/// check-perform-mark critical section.
///
/// Gates are striped over a fixed array so the coordination cost and memory are
/// bounded; distinct operations that hash to the same stripe simply serialize
/// briefly without affecting correctness.
/// </summary>
public static class OperationSerialization
{
    private const int StripeCount = 64;
    private static readonly SemaphoreSlim[] Stripes = CreateStripes();

    public static async Task<IDisposable> AcquireAsync(
        string tenantId,
        string operationId,
        CancellationToken cancellationToken)
    {
        var gate = Stripes[Stripe(tenantId, operationId)];
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        return new Releaser(gate);
    }

    private static int Stripe(string tenantId, string operationId)
        => (int)(StableHash(tenantId ?? string.Empty, operationId ?? string.Empty) % (uint)StripeCount);

    private static uint StableHash(string tenantId, string operationId)
    {
        const uint offset = 2166136261;
        const uint prime = 16777619;
        var hash = offset;

        foreach (var value in Encoding.UTF8.GetBytes($"{tenantId}\u001f{operationId}"))
        {
            hash = (hash ^ value) * prime;
        }

        return hash;
    }

    private static SemaphoreSlim[] CreateStripes()
    {
        var stripes = new SemaphoreSlim[StripeCount];
        for (var index = 0; index < stripes.Length; index++)
        {
            stripes[index] = new SemaphoreSlim(1, 1);
        }

        return stripes;
    }

    private sealed class Releaser : IDisposable
    {
        private readonly SemaphoreSlim gate;
        private int disposed;

        public Releaser(SemaphoreSlim gate) => this.gate = gate;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0)
            {
                gate.Release();
            }
        }
    }
}
