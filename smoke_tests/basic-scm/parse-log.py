#!/usr/bin/env python3
import sys, json

for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        t = obj.get('time','')[11:19]
        lvl = obj.get('level', 0)
        msg = obj.get('msg', '')
        comp = obj.get('component', '')

        # Work item lifecycle
        if any(k in msg for k in ['Processing work item', 'Work item completed', 'Work item failed', 'Executing work item']):
            print(f'{t} [{comp}] {msg[:180]}')

        # ALL shell permission requests
        elif comp == 'Permissions' and obj.get('kind') == 'shell':
            cmd = obj.get('command', obj.get('details', {}).get('fullCommandText', ''))
            decision = obj.get('decision', 'request')
            print(f'{t} SHELL [{decision}]: {cmd[:150]}')

        # Errors
        elif lvl >= 40:
            err = obj.get('err', '')
            print(f'{t} ERROR [{comp}] {msg[:150]} {str(err)[:100]}')

        # Session timeout/completion
        elif 'timeout' in msg.lower() or 'timed out' in msg.lower():
            print(f'{t} [{comp}] {msg[:180]}')

    except:
        pass
