export const TURN_COMPLETION_CONTRACT = [
    '<agent_nexus_completion_contract>',
    'Do not end this turn while requested work is still running or incomplete.',
    'If you need user input or permission, use the protocol input/permission request and wait for the response.',
    'Before ending the turn, verify the requested work and provide a non-empty final response.',
    'The final response must summarize the outcome, verification performed, and workspace-relative paths for generated files.',
    'Attach generated resources or artifacts through the protocol when supported.',
    '</agent_nexus_completion_contract>'
].join('\n')
