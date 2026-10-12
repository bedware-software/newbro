Each task must be its own iteration.

Task 1:
- I don't like how mode button (command/insert) looks in browser header.
    - it places between 2 delimeters, leave only one. button itself move in between lock icon and url input (see small 1px gap in there? leave such a gap from both sides for the button)
    - change its styling to no rounding edges
    - make font bigger a bit (I want actual text occupy more space)
    - Background too bright
    - maybe u can suggest me something to make it more pleasant for me?
- Change everywhere WEB mode to BROWSE (more logical as for mode name)
    - for BROWSE mode change color to yellow (from violet)
- Change default hotkeys in Vim Mode
    - its ok that we have close hotkey for both command and browse modes, but they should be same => x
    - in command mode we have i to go insert mode, make w to go browse mode (not only enter). (w must not close the tab, as it is right now in web mode)
    - default search hotkey - f, not p (its semanticall much better [F]ind [W]orkspaces)
    - o as focus search input must be changed to ctrl+l
    - p - must paste url from clipboard and open it in the current tab, P - in new tab, y - must copy current page url to clipboard
- I don't know reason why we don't have vim mode support in command palette
- I like styling of downloads page in general and hints on this page especially
    - we use similar styling in search everywhere for hints but if there are any differences use downloads page as reference
    - i want to try to move hints block above the search bar in search everywhere (command palette ofc also)
    - i very like how hint look for search (/) in hints bar, but it looks ugly in search downloads input field. Use (prefer) that styling and size (height?) of key hints from the header in downloads 
- add hints bar in sidebar and bookshelf (at the bottom)
- Find on page must be reworked
    - i dont like it shifts whole page down. remake to popup in right top corner. also must support command/insert in vim mode. jk for next/prev element
- When suggestions popup appears for search inbox it has small gap before first element (like margin), also shadow it drops is cropped
- We have already changed behavior on switchin tabs in sidebar, i want to impove it
    - sometimes usefull to open tabs as I switch, so for that purpose
    - in command mode
    - jk -> switch down/up to tab
    - JK -> move tab down/up
    - <ctrl>-j/k -> switch to tab and open it
    - also we have chenged o to ctrl-l, so its free, i want to use it to open selected tab but not focus page, leave in command mode

Task 2:
- I want to add Split feature like in other browsers. i press S -> second half appear from the right (V -> from the down). in that new whole space appears popup modal window like search everywhere with tab filter and suggests tabs from this workspace. i hit enter it opened in new space. do something to show it sidebar correctly (u could look how other browsers do).

Task 3:
- I want to superpower input search edit. now we have (if all above is done) ctrl+l to focus input search. then i can work with it like with usual text
    - But i want to add e - hotkey in command mode that must edit url input in superpower mode
    - superpower mode must:
        - hide initial url input at the top (there we should probably show some info, i propose some stats for now, like count of workspaces and tabs, so on..)
        - show modal window with bigger (lets start with 2x) url input and hints bar below it (usual size) with current page url
        - show in url input http://yandex.ru/maps/cities/streets?a=b&c=d
        - and below show    [proto][ domain] [l1] [  l2] [resou][parameters]
        - and quick edit       [p]    [d]    [1]   [2]    [3]        [s]
        - quick edits just shown but available only for intents:
            - c (prefix) -> change block in url
                - quick edit must select corresponding block and go insert mode
            - r -> remove (s) parameters http://ya.ru/maps/cities/streets?a=b&c=d to http://ya.ru/maps/cities/streets
            - y - copy to cliboard
            - p - paste from clipboard
        - then we have vim mode in this modal
        - by default go with command mode, nothing selected
        - A -> put cursor a the end
        - I -> at the beggining
        - n -> copy title/name of the page
        - C -> remove all, go insert
        - i -> where left last time
        - u -> remove last section in url for example http://ya.ru/maps/cities/streets?a=b&c=d to http://ya.ru/maps/cities
        - t -> leave only domain in url for example http://ya.ru/maps/cities/streets?a=b&c=d to http://ya.ru
        - y - copy whole url to clipboard
        - p - paste from clipboard replacing whole url

