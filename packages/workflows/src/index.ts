/** Workflow contracts grow here in Step 3; Step 1 executes no workflows. */
export type WorkflowDefinition = {
  id: string;
  name: string;
  nodes: readonly string[];
};
