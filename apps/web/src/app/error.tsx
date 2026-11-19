'use client';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast-provider';
export default function ErrorPage({ reset }: { reset: () => void }) {
  const toast = useToast();
  return (
    <div role="alert" className="rounded-2xl border border-border p-8">
      <h1 className="text-2xl font-semibold">
        Workspace temporarily unavailable
      </h1>
      <p className="my-4 text-muted-foreground">
        We could not verify your session. Check that the API is running and try
        again.
      </p>
      <Button
        onClick={() => {
          toast.success('Workspace reload requested.');
          reset();
        }}
      >
        Try again
      </Button>
    </div>
  );
}
