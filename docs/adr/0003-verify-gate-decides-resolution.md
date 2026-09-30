# The verify gate, not the agent, decides that a ticket is resolved

A ticket becomes `resolved` only when its verify gate commands all succeed after an attempt. An agent's own claim that it is done, whether a completion marker, ticked checkboxes or a final message, is advisory and never resolves a ticket. Unattended loops that trust the agent mark unfinished work as done, and the cost of that isn't visible until much later. A ticket without verify commands can't be resolved automatically. After its attempt it goes to `needs-info` for a human to check.
