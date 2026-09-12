/** Only a direct stop utterance can preempt a running task; never interpret arbitrary busy speech as tools. */
export function isStopCommand(text: string, aiName: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  let command = normalize(text);
  const name = normalize(aiName);
  command = command.replace(/^(?:hey|okay|ok)\s+/, '');
  if (name && command.startsWith(name + ' ')) command = command.slice(name.length + 1);
  command = command.replace(/^(?:can|could|would) you\s+/, '');
  command = command.replace(/^please\s+/, '').replace(/\s+please$/, '');
  if (name && command.endsWith(' ' + name)) command = command.slice(0, -name.length - 1);
  return /^(?:stop(?: everything| moving| walking| following| mining| digging| working| doing that| the (?:task|bot)| what you(?:'re| are) doing)?(?: now)?|cancel(?: the| my| current)?(?: task| command| action)?(?: now)?|halt(?: now)?)$/.test(command);
}
