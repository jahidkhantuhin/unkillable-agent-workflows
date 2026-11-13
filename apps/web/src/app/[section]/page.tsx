import { notFound } from 'next/navigation';
const descriptions: Record<string, string> = {
  runs: 'Durable run creation and the event timeline arrive in Step 3.',
  approvals: 'The human approval inbox arrives in Step 5.',
  workflows: 'The support ticket workflow arrives in Step 6.',
  chaos: 'The development chaos control panel arrives in Step 9.',
  analytics: 'Approval analytics arrive in Step 11.',
};
export function generateStaticParams() {
  return Object.keys(descriptions).map((section) => ({ section }));
}
export default async function Section({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!Object.hasOwn(descriptions, section)) notFound();
  return (
    <>
      <p className="text-xs tracking-widest text-emerald-500">WORKSPACE</p>
      <h1 className="mt-4 text-4xl font-semibold capitalize">{section}</h1>
      <div className="mt-8 rounded-2xl border border-dashed border-border p-12">
        <h2 className="text-lg font-medium">
          Your workspace is ready to grow.
        </h2>
        <p className="mt-3 text-muted-foreground">{descriptions[section]}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          This foundation has no workflow execution or demo metrics yet.
        </p>
      </div>
    </>
  );
}
