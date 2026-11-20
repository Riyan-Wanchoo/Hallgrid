import time
import array
import sys
import json
import random
import select
import math
from machine import Pin, disable_irq, enable_irq
import rp2


# --- CONFIGURATION ---
PIN = 17
TOTAL_LEDS = 146

SETUP_BRIGHTNESS = 14
NORMAL_BRIGHTNESS = 30

global_brightness = NORMAL_BRIGHTNESS
target_brightness = NORMAL_BRIGHTNESS
brightness_transition_active = False
last_brightness_update_ms = 0
BRIGHTNESS_UPDATE_INTERVAL_MS = 70
end_effect_active = False


CREAM_RGB = (135, 120, 65)
GREEN_RGB = (30, 70, 6)

RED_RGB = (255, 0, 0)
ILLEGAL_RED_RGB = (140, 0, 0)
YELLOW_RGB = (255, 210, 0)

WIN_RIPPLE_RGB = (0, 150, 0)
LOSS_RIPPLE_RGB = (255, 0, 0)
DRAW_RIPPLE_RGB = (255, 210, 0)
CASUAL_WHITE_WIN_RIPPLE_RGB = CREAM_RGB
CASUAL_BLACK_WIN_RIPPLE_RGB = (0, 150, 0)


RING_DELAY_MS = 100
COLOUR_GAP_MS = 50


SPIRAL_DELAY_MS = 45
DIAGONAL_DELAY_MS = 100
CURTAIN_DELAY_MS = 180
SPARKLE_DELAY_MS = 55


RUSH_STRIKE_BREATH_MS = 2000


FLASH_ON_MS = 100
FLASH_OFF_MS = 100

current_animation_name = None
loading_loop_active = False


CHECK_ON_MS = 800
ILLEGAL_BREATH_MS = 300
MATCH_FAILED_BREATH_MS = 2000

rush_score_active = False
rush_score_data = None

rush_opponent_active = False
rush_opponent_squares = None

scan_occupancy_active = False
scan_occupancy_squares = None

rush_wrong_then_strike = False
rush_prompt_start_ms = 0

RUSH_PROMPT_UPDATE_MS = 30
RUSH_PROMPT_PERIOD_MS = 1800


VIBGYOR_COLOURS = [
    (148, 0, 211),   # Violet
    (60, 0, 130),    # Indigo
    (0, 0, 255),     # Blue
    (0, 255, 0),     # Green
    (255, 180, 0),   # Yellow
    (255, 65, 0),    # Orange
    (255, 0, 0),     # Red
]

rush_prompt_active = False
rush_prompt_square = None
rush_prompt_rgb = None
rush_prompt_next_ms = 0
rush_prompt_on = False

rush_strike_active = False
rush_strike_next_ms = 0
rush_strike_level = 0.0

rush_breath_active = False
rush_breath_rgb = (0, 180, 0)
rush_breath_start_ms = 0
rush_breath_duration_ms = 3500
RUSH_BREATH_PERIOD_MS = 1600


# --- WS2812 PIO DRIVER ---
@rp2.asm_pio(
    sideset_init=rp2.PIO.OUT_LOW,
    out_shiftdir=rp2.PIO.SHIFT_LEFT,
    autopull=True,
    pull_thresh=24,
    fifo_join=rp2.PIO.JOIN_TX
)
def ws2812():
    T1 = 2
    T2 = 5
    T3 = 3

    wrap_target()
    label("bitloop")
    out(x, 1)             .side(0) [T3 - 1]
    jmp(not_x, "do_zero") .side(1) [T1 - 1]
    jmp("bitloop")        .side(1) [T2 - 1]
    label("do_zero")
    nop()                 .side(0) [T2 - 1]
    wrap()


sm = rp2.StateMachine(
    0,
    ws2812,
    freq=8_000_000,
    sideset_base=Pin(PIN)
)
sm.active(1)


# --- ROW MAPPINGS ---
ROW_LEDS = [
    # Row 1
    [
        [0, 1, 2], [3, 4], [5, 6], [7, 8, 9],
        [10, 11], [12, 13, 14], [15, 16], [17, 18],
    ],

    # Row 2
    [
        [35, 36], [33, 34], [30, 31, 32], [28, 29],
        [26, 27], [23, 24, 25], [21, 22], [19, 20],
    ],

    # Row 3
    [
        [37, 38], [39, 40], [41, 42, 43], [44, 45],
        [46, 47], [48, 49, 50], [51, 52], [53, 54],
    ],

    # Row 4
    [
        [71, 72], [69, 70], [66, 67, 68], [64, 65],
        [62, 63], [59, 60, 61], [57, 58], [55, 56],
    ],

    # Row 5
    [
        [73, 74], [75, 76], [77, 78, 79], [80, 81],
        [82, 83], [84, 85, 86], [87, 88], [89, 90],
    ],

    # Row 6
    [
        [107, 108],
        [105, 106],
        [102, 103, 104],
        [100, 101],
        [98, 99],
        [95, 96, 97],
        [93, 94],
        [91, 92],
    ],

    # Row 7
    [
        [109, 110], [111, 112], [113, 114], [115, 116, 117],
        [118, 119], [120, 121, 122], [123, 124], [125, 126],
    ],

    # Row 8
    [
        [143, 144, 145],
        [141, 142],
        [139, 140],
        [136, 137, 138],
        [134, 135],
        [131, 132, 133],
        [129, 130],
        [127, 128],
    ],
]


ROW_STARTS_CREAM = [
    True, False, True, False,
    True, False, True, False
]


ALL_ROWS = []


for row in range(8):
    row_map = {}

    for col in range(8):
        cream_square = (
            col % 2 == 0
            if ROW_STARTS_CREAM[row]
            else col % 2 == 1
        )

        row_map[col] = {
            "leds": ROW_LEDS[row][col],
            "color": "white" if cream_square else "green"
        }

    ALL_ROWS.append(row_map)


frame = array.array("I", [0] * TOTAL_LEDS)


animation_steps = []
animation_index = 0
animation_active = False
next_animation_ms = 0


special_effect_steps = []
special_effect_index = 0
special_effect_active = False
next_special_effect_ms = 0


illegal_effect_active = False
illegal_effect_next_ms = 0
illegal_effect_on = False
match_failed_effect_active = False
match_failed_effect_start_ms = 0


last_move = None
pending_bot_move = None


# --- DISPLAY FUNCTIONS ---
def grb(r, g, b, square_factor=1.0):
    factor = (global_brightness / 100.0) * square_factor

    return (
        (int(g * factor) << 16)
        | (int(r * factor) << 8)
        | int(b * factor)
    )


def scale_rgb(rgb, factor):
    return tuple(int(channel * factor) for channel in rgb)


def square_rgb(row, col):
    if ALL_ROWS[row][col]["color"] == "white":
        return CREAM_RGB

    return GREEN_RGB


def clear_frame():
    for i in range(TOTAL_LEDS):
        frame[i] = 0


def send_frame():
    irq_state = disable_irq()

    try:
        sm.put(frame, 8)
    finally:
        enable_irq(irq_state)

    time.sleep_ms(2)


def paint_square(row, col, rgb):
    led_indices = ALL_ROWS[row][col]["leds"]

    square_factor = 2.0 / len(led_indices)
    colour = grb(*rgb, square_factor=square_factor)

    for led_idx in led_indices:
        frame[led_idx] = colour


def render_rows(row_maps, force_color=None):
    clear_frame()

    colours = {
        "white": CREAM_RGB,
        "green": GREEN_RGB,
    }

    for row_map in row_maps:
        for box in row_map.values():
            colour_name = (
                force_color
                if force_color is not None
                else box["color"]
            )

            rgb = colours[colour_name]
            led_indices = box["leds"]

            square_factor = 2.0 / len(led_indices)
            colour = grb(*rgb, square_factor=square_factor)

            for led_idx in led_indices:
                frame[led_idx] = colour

    send_frame()


def render_animation_step():
    clear_frame()

    duration, squares = animation_steps[animation_index]

    for row, col, rgb in squares:
        paint_square(row, col, rgb)

    send_frame()


def render_special_effect_step():
    clear_frame()

    duration, squares = special_effect_steps[special_effect_index]

    for row, col, rgb in squares:
        paint_square(row, col, rgb)

    send_frame()


def render_game_board():
    render_rows(ALL_ROWS)

    if last_move:
        paint_square(
            last_move["from_row"],
            last_move["from_col"],
            YELLOW_RGB,
        )

        paint_square(
            last_move["to_row"],
            last_move["to_col"],
            YELLOW_RGB,
        )

    if pending_bot_move:
        paint_square(
            pending_bot_move["from_row"],
            pending_bot_move["from_col"],
            RED_RGB,
        )

        paint_square(
            pending_bot_move["to_row"],
            pending_bot_move["to_col"],
            RED_RGB,
        )

    if rush_opponent_active and rush_opponent_squares:
        for row, col in rush_opponent_squares:
            paint_square(row, col, RED_RGB)

    if rush_score_active and rush_score_data:
        for row, col, rgb in rush_score_strip_squares(rush_score_data):
            paint_square(row, col, rgb)

    if scan_occupancy_active and scan_occupancy_squares:
        for row, col in scan_occupancy_squares:
            paint_square(row, col, RED_RGB)

    send_frame()


def turn_off_all(announce=True):
    global last_move, pending_bot_move
    global target_brightness, brightness_transition_active
    global illegal_effect_active
    global scan_occupancy_active, scan_occupancy_squares

    clear_frame()
    send_frame()

    last_move = None
    pending_bot_move = None
    scan_occupancy_active = False
    scan_occupancy_squares = None
    target_brightness = NORMAL_BRIGHTNESS
    brightness_transition_active = False
    illegal_effect_active = False

    if announce:
        print("\n[All lights turned off]")


# --- ANIMATION HELPERS ---
ALL_SQUARES = [
    (row, col)
    for row in range(8)
    for col in range(8)
]


RIPPLE_RINGS = [[], [], [], []]


for row, col in ALL_SQUARES:
    ring = max(
        abs(2 * row - 7),
        abs(2 * col - 7)
    ) // 2

    RIPPLE_RINGS[ring].append((row, col))


def chess_pixels(squares):
    return [
        (row, col, square_rgb(row, col))
        for row, col in squares
    ]


def solid_pixels(squares, rgb):
    return [
        (row, col, rgb)
        for row, col in squares
    ]


def append_finish_flashes(steps):
    for _ in range(2):
        steps.append((
            FLASH_ON_MS,
            solid_pixels(ALL_SQUARES, GREEN_RGB)
        ))
        steps.append((FLASH_OFF_MS, []))

    return steps


def build_vibgyor_ripple():
    steps = []

    for rgb in VIBGYOR_COLOURS:
        for ring in RIPPLE_RINGS:
            steps.append((
                RING_DELAY_MS,
                solid_pixels(ring, rgb)
            ))

        steps.append((COLOUR_GAP_MS, []))

    return append_finish_flashes(steps)


def build_vibgyor_loop():
    steps = []

    for rgb in VIBGYOR_COLOURS:
        for ring in RIPPLE_RINGS:
            steps.append((
                RING_DELAY_MS,
                solid_pixels(ring, rgb)
            ))

        steps.append((
            COLOUR_GAP_MS,
            []
        ))

    return steps


def build_scan_wave():
    steps = []
    scan_rgb = (180, 175, 140)
    cols = list(range(8)) + list(range(6, 0, -1))
    for head_col in cols:
        pixels = []
        for row in range(8):
            for col in range(8):
                dist = abs(col - head_col)
                if dist == 0:
                    pixels.append((row, col, scan_rgb))
                elif dist == 1:
                    pixels.append((row, col, scale_rgb(scan_rgb, 0.35)))
        steps.append((85, pixels))
    return steps


def build_rainbow_spiral():
    path = []

    top = 0
    bottom = 7
    left = 0
    right = 7

    while top <= bottom and left <= right:
        for col in range(left, right + 1):
            path.append((top, col))
        top += 1

        for row in range(top, bottom + 1):
            path.append((row, right))
        right -= 1

        if top <= bottom:
            for col in range(right, left - 1, -1):
                path.append((bottom, col))
            bottom -= 1

        if left <= right:
            for row in range(bottom, top - 1, -1):
                path.append((row, left))
            left += 1

    steps = []
    trail_length = 8

    for position in range(len(path) + trail_length):
        pixels = []

        for age in range(trail_length):
            path_index = position - age

            if 0 <= path_index < len(path):
                row, col = path[path_index]

                rgb = VIBGYOR_COLOURS[
                    (path_index // 3) % len(VIBGYOR_COLOURS)
                ]

                fade = (1.0 - age / trail_length) ** 2

                pixels.append((
                    row,
                    col,
                    scale_rgb(rgb, fade)
                ))

        steps.append((SPIRAL_DELAY_MS, pixels))

    return append_finish_flashes(steps)


def build_diagonal_sweep():
    steps = []

    for reverse in (False, True):
        head_rgb = GREEN_RGB if not reverse else CREAM_RGB

        for position in range(18):
            pixels = []

            for row, col in ALL_SQUARES:
                diagonal = (
                    row + col
                    if not reverse
                    else row + (7 - col)
                )

                age = position - diagonal

                if 0 <= age < 4:
                    fade = (1.0 - age / 4.0) ** 2

                    pixels.append((
                        row,
                        col,
                        scale_rgb(head_rgb, fade)
                    ))

            steps.append((DIAGONAL_DELAY_MS, pixels))

    return append_finish_flashes(steps)


def build_centre_curtain():
    steps = []

    for stage in range(4):
        revealed = [
            (row, col)
            for row, col in ALL_SQUARES
            if abs(2 * col - 7) <= 2 * stage + 1
        ]

        steps.append((
            CURTAIN_DELAY_MS,
            chess_pixels(revealed)
        ))

    steps.append((
        10000,
        chess_pixels(ALL_SQUARES)
    ))

    return steps


def build_sparkle_reveal():
    order = list(ALL_SQUARES)

    for i in range(len(order) - 1, 0, -1):
        j = random.getrandbits(16) % (i + 1)
        order[i], order[j] = order[j], order[i]

    steps = []
    settled = []

    for row, col in order:
        pixels = chess_pixels(settled)
        pixels.append((row, col, CREAM_RGB))
        steps.append((SPARKLE_DELAY_MS, pixels))

        settled.append((row, col))
        steps.append((
            SPARKLE_DELAY_MS,
            chess_pixels(settled)
        ))

    return append_finish_flashes(steps)


ANIMATION_BUILDERS = {
    "vibgyor": build_vibgyor_ripple,
    "vibgyor_loop": build_vibgyor_loop,
    "scan_wave": build_scan_wave,
    "spiral": build_rainbow_spiral,
    "diagonal": build_diagonal_sweep,
    "curtain": build_centre_curtain,
    "sparkle": build_sparkle_reveal,
}


def validate_animation(steps):
    for duration, pixels in steps:
        assert duration > 0

        seen = set()

        for row, col, rgb in pixels:
            assert 0 <= row < 8
            assert 0 <= col < 8
            assert (row, col) not in seen
            assert len(rgb) == 3

            for channel in rgb:
                assert 0 <= channel <= 255

            seen.add((row, col))


def start_animation(builder, animation_name=None, loop=False):
    global animation_steps, animation_index
    global animation_active, next_animation_ms
    global current_animation_name, loading_loop_active

    animation_active = False
    animation_steps = []

    new_steps = builder()
    validate_animation(new_steps)

    animation_steps = new_steps
    animation_index = 0
    animation_active = True
    current_animation_name = animation_name
    loading_loop_active = loop

    render_animation_step()

    next_animation_ms = time.ticks_add(
        time.ticks_ms(),
        animation_steps[animation_index][0]
    )


def stop_animation():
    global animation_active, animation_steps

    animation_active = False
    animation_steps = []


def update_animation():
    global animation_active, animation_index
    global animation_steps, next_animation_ms
    global current_animation_name, loading_loop_active

    if not animation_active:
        return

    if time.ticks_diff(time.ticks_ms(), next_animation_ms) < 0:
        return

    animation_index += 1

    if animation_index >= len(animation_steps):
        animation_active = False
        animation_steps = []

        if loading_loop_active and current_animation_name:
            builder = ANIMATION_BUILDERS.get(
                current_animation_name
            )

            if builder:
                start_animation(
                    builder,
                    current_animation_name,
                    True,
                )
                return

        render_game_board()
        return

    render_animation_step()

    next_animation_ms = time.ticks_add(
        time.ticks_ms(),
        animation_steps[animation_index][0]
    )


# --- SPECIAL EFFECTS ---
def start_special_effect(steps):
    global special_effect_steps, special_effect_index
    global special_effect_active, next_special_effect_ms

    validate_animation(steps)

    special_effect_steps = steps
    special_effect_index = 0
    special_effect_active = True

    render_special_effect_step()

    next_special_effect_ms = time.ticks_add(
        time.ticks_ms(),
        special_effect_steps[special_effect_index][0]
    )


def stop_special_effect():
    global special_effect_active
    global special_effect_steps
    global end_effect_active

    special_effect_active = False
    special_effect_steps = []
    end_effect_active = False


def update_special_effect():
    global special_effect_active
    global rush_wrong_then_strike
    global special_effect_index
    global special_effect_steps
    global next_special_effect_ms
    global end_effect_active

    if not special_effect_active:
        return

    if time.ticks_diff(time.ticks_ms(), next_special_effect_ms) < 0:
        return

    special_effect_index += 1

    if special_effect_index >= len(special_effect_steps):
        special_effect_active = False
        special_effect_steps = []

        if rush_wrong_then_strike:
            rush_wrong_then_strike = False
            start_rush_strike_lock()
            return

        if end_effect_active:
            end_effect_active = False

            clear_frame()
            send_frame()

            last_move = None
            pending_bot_move = None

            return

        render_game_board()
        return

    render_special_effect_step()

    next_special_effect_ms = time.ticks_add(
        time.ticks_ms(),
        special_effect_steps[special_effect_index][0]
    )


# --- ILLEGAL MOVE EFFECT ---
def start_illegal_effect():
    global illegal_effect_active
    global illegal_effect_next_ms
    global illegal_effect_on

    stop_animation()
    stop_special_effect()

    illegal_effect_active = True
    illegal_effect_on = False
    illegal_effect_next_ms = time.ticks_ms()

    clear_frame()
    send_frame()


def start_match_failed_effect():
    global match_failed_effect_active
    global match_failed_effect_start_ms

    stop_animation()
    stop_special_effect()
    stop_illegal_effect()

    match_failed_effect_active = True
    match_failed_effect_start_ms = time.ticks_ms()


def stop_match_failed_effect():
    global match_failed_effect_active

    match_failed_effect_active = False


def update_match_failed_effect():
    global match_failed_effect_active
    global match_failed_effect_start_ms

    if not match_failed_effect_active:
        return

    now = time.ticks_ms()

    elapsed = time.ticks_diff(
        now,
        match_failed_effect_start_ms,
    )

    period = MATCH_FAILED_BREATH_MS

    phase = (elapsed % period) / period

    brightness = (
        0.15
        + 0.85 * (
            0.5
- 0.5 * math.cos(2 * math.pi * phase)
        )
    )

    clear_frame()

    for row, col in ALL_SQUARES:
        led_indices = ALL_ROWS[row][col]["leds"]

        square_factor = 2.0 / len(led_indices)

        level = brightness * square_factor

        red = int(ILLEGAL_RED_RGB[0] * level)
        green = int(ILLEGAL_RED_RGB[1] * level)
        blue = int(ILLEGAL_RED_RGB[2] * level)

        colour = (
            (green << 16)
            | (red << 8)
            | blue
        )

        for led_idx in led_indices:
            frame[led_idx] = colour

    send_frame()


def stop_illegal_effect():
    global illegal_effect_active
    global match_failed_effect_active

    illegal_effect_active = False
    match_failed_effect_active = False


def update_illegal_effect():
    global illegal_effect_active
    global illegal_effect_next_ms
    global illegal_effect_on

    if not illegal_effect_active:
        return

    now = time.ticks_ms()

    if time.ticks_diff(now, illegal_effect_next_ms) < 0:
        return

    illegal_effect_next_ms = time.ticks_add(
        now,
        ILLEGAL_BREATH_MS,
    )

    illegal_effect_on = not illegal_effect_on

    if illegal_effect_on:
        render_rows(ALL_ROWS)

        for row, col in ALL_SQUARES:
            paint_square(row, col, ILLEGAL_RED_RGB)

        send_frame()
    else:
        clear_frame()
        send_frame()


def build_end_ripple(result):
    if result == "white_win":
        ripple_rgb = WIN_RIPPLE_RGB
    elif result == "black_win":
        ripple_rgb = LOSS_RIPPLE_RGB
    elif result == "casual_white_win":
        ripple_rgb = CASUAL_WHITE_WIN_RIPPLE_RGB
    elif result == "casual_black_win":
        ripple_rgb = CASUAL_BLACK_WIN_RIPPLE_RGB
    else:
        ripple_rgb = DRAW_RIPPLE_RGB

    steps = []

    for _ in range(3):
        for ring in RIPPLE_RINGS:
            steps.append((
                RING_DELAY_MS,
                solid_pixels(ring, ripple_rgb),
            ))

        steps.append((COLOUR_GAP_MS, []))

    steps.append((300, []))

    return steps


# --- GAME BOARD COMMANDS ---
def square_name_to_coords(square):
    square = str(square).strip().lower()

    if len(square) != 2:
        raise ValueError("Invalid square: " + square)

    file_char = square[0]
    rank_char = square[1]

    if file_char not in "abcdefgh" or rank_char not in "12345678":
        raise ValueError("Invalid square: " + square)

    col = ord(file_char) - ord("a")
    row = 8 - int(rank_char)

    return row, col


def show_pending_move(from_square, to_square):
    global last_move, pending_bot_move

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    row_from, col_from = square_name_to_coords(from_square)
    row_to, col_to = square_name_to_coords(to_square)

    last_move = None
    pending_bot_move = {
        "from_row": row_from,
        "from_col": col_from,
        "to_row": row_to,
        "to_col": col_to,
    }

    render_rows(ALL_ROWS)

    paint_square(row_from, col_from, RED_RGB)
    paint_square(row_to, col_to, RED_RGB)

    send_frame()


def show_last_move(from_square, to_square):
    global last_move, pending_bot_move

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    row_from, col_from = square_name_to_coords(from_square)
    row_to, col_to = square_name_to_coords(to_square)

    pending_bot_move = None
    last_move = {
        "from_row": row_from,
        "from_col": col_from,
        "to_row": row_to,
        "to_col": col_to,
    }

    render_rows(ALL_ROWS)

    paint_square(row_from, col_from, YELLOW_RGB)
    paint_square(row_to, col_to, YELLOW_RGB)

    send_frame()


def show_game_highlight(
    last_from,
    last_to,
    pending_from=None,
    pending_to=None,
):
    global last_move, pending_bot_move

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    render_rows(ALL_ROWS)

    last_move = None
    pending_bot_move = None

    if last_from and last_to:
        last_row_from, last_col_from = square_name_to_coords(last_from)
        last_row_to, last_col_to = square_name_to_coords(last_to)

        last_move = {
            "from_row": last_row_from,
            "from_col": last_col_from,
            "to_row": last_row_to,
            "to_col": last_col_to,
        }

        paint_square(last_row_from, last_col_from, YELLOW_RGB)
        paint_square(last_row_to, last_col_to, YELLOW_RGB)

    if pending_from and pending_to:
        pending_row_from, pending_col_from = square_name_to_coords(
            pending_from
        )
        pending_row_to, pending_col_to = square_name_to_coords(
            pending_to
        )

        pending_bot_move = {
            "from_row": pending_row_from,
            "from_col": pending_col_from,
            "to_row": pending_row_to,
            "to_col": pending_col_to,
        }

        paint_square(pending_row_from, pending_col_from, RED_RGB)
        paint_square(pending_row_to, pending_col_to, RED_RGB)

    send_frame()


def show_check(king_square):
    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    king_row, king_col = square_name_to_coords(king_square)

    render_rows(ALL_ROWS)

    if last_move:
        paint_square(
            last_move["from_row"],
            last_move["from_col"],
            YELLOW_RGB,
        )

        paint_square(
            last_move["to_row"],
            last_move["to_col"],
            YELLOW_RGB,
        )

    if pending_bot_move:
        paint_square(
            pending_bot_move["from_row"],
            pending_bot_move["from_col"],
            RED_RGB,
        )

        paint_square(
            pending_bot_move["to_row"],
            pending_bot_move["to_col"],
            RED_RGB,
        )

    paint_square(king_row, king_col, RED_RGB)

    send_frame()
    time.sleep_ms(CHECK_ON_MS)

    render_game_board()


def show_illegal_move():
    start_illegal_effect()


def play_loading_animation(animation_name="vibgyor", loop=False):
    stop_illegal_effect()

    builder = ANIMATION_BUILDERS.get(animation_name)

    if builder is None:
        builder = build_vibgyor_ripple
        animation_name = "vibgyor"

    start_animation(
        builder,
        animation_name,
        loop,
    )


def play_end_animation(result):
    global end_effect_active

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    end_effect_active = True

    start_special_effect(
        build_end_ripple(result)
    )


def build_match_found_flashes():
    steps = []

    for _ in range(2):
        steps.append((
            FLASH_ON_MS,
            solid_pixels(
                ALL_SQUARES,
                (0, 150, 0),
            )
        ))

        steps.append((
            FLASH_OFF_MS,
            []
        ))

    steps.append((
        10000,
        chess_pixels(ALL_SQUARES)
    ))

    return steps


def setup_board():
    global last_move, pending_bot_move
    global global_brightness, target_brightness, brightness_transition_active

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    last_move = None
    pending_bot_move = None

    global_brightness = SETUP_BRIGHTNESS
    target_brightness = SETUP_BRIGHTNESS
    brightness_transition_active = False

    render_rows(ALL_ROWS)


def ready_board():
    global global_brightness, target_brightness, brightness_transition_active
    global last_brightness_update_ms

    stop_illegal_effect()
    stop_animation()
    stop_special_effect()

    global_brightness = NORMAL_BRIGHTNESS
    target_brightness = NORMAL_BRIGHTNESS
    brightness_transition_active = False
    last_brightness_update_ms = time.ticks_ms()
    render_rows(ALL_ROWS)


def update_brightness_transition():
    global global_brightness
    global brightness_transition_active
    global last_brightness_update_ms

    if not brightness_transition_active:
        return

    now = time.ticks_ms()

    if time.ticks_diff(
        now,
        last_brightness_update_ms
    ) < BRIGHTNESS_UPDATE_INTERVAL_MS:
        return

    last_brightness_update_ms = now

    if global_brightness < target_brightness:
        global_brightness = min(
            global_brightness + 1,
            target_brightness,
        )

        render_game_board()

        if global_brightness >= target_brightness:
            brightness_transition_active = False


def rush_square_rgb(square):
    file_char = square[0]
    rank_char = square[1]

    col = ord(file_char) - ord("a")
    row = 8 - int(rank_char)

    return row, col


def stop_rush_prompt():
    global rush_prompt_active
    global rush_prompt_square
    global rush_prompt_rgb

    rush_prompt_active = False
    rush_prompt_square = None
    rush_prompt_rgb = None


def stop_rush_strike_lock():
    global rush_strike_active

    rush_strike_active = False


def stop_rush_breath():
    global rush_breath_active

    rush_breath_active = False


def start_rush_breath(rgb, duration_ms=3500):
    global rush_breath_active, rush_breath_rgb
    global rush_breath_start_ms, rush_breath_duration_ms
    global rush_score_active, rush_opponent_active

    stop_animation()
    stop_special_effect()
    stop_illegal_effect()
    stop_match_failed_effect()
    stop_rush_prompt()
    stop_rush_strike_lock()

    rush_score_active = False
    rush_opponent_active = False
    rush_breath_active = True
    rush_breath_rgb = rgb
    rush_breath_start_ms = time.ticks_ms()
    rush_breath_duration_ms = duration_ms


def update_rush_breath_effect():
    global rush_breath_active

    if not rush_breath_active:
        return

    now = time.ticks_ms()
    elapsed = time.ticks_diff(now, rush_breath_start_ms)

    if elapsed >= rush_breath_duration_ms:
        rush_breath_active = False
        turn_off_all(announce=False)
        return

    phase = (elapsed % RUSH_BREATH_PERIOD_MS) / RUSH_BREATH_PERIOD_MS
    level = 0.12 + 0.88 * (0.5 - 0.5 * math.cos(2 * math.pi * phase))

    clear_frame()
    scaled = scale_rgb(rush_breath_rgb, level)
    for row, col in ALL_SQUARES:
        paint_square(row, col, scaled)
    send_frame()


def show_rush_piece_group(squares, rgb):
    global rush_score_active, rush_opponent_active

    stop_animation()
    stop_special_effect()
    stop_illegal_effect()
    stop_match_failed_effect()
    stop_rush_prompt()
    stop_rush_strike_lock()
    stop_rush_breath()

    rush_score_active = False
    rush_opponent_active = False

    clear_frame()
    for row in range(8):
        for col in range(8):
            dim_rgb = scale_rgb(square_rgb(row, col), 0.20)
            paint_square(row, col, dim_rgb)

    for sq in squares:
        r, c = rush_square_rgb(sq)
        paint_square(r, c, rgb)

    send_frame()


def rush_score_strip_squares(results):
    squares = []
    for index in range(min(8, len(results))):
        status = results[index]
        if status == "correct":
            rgb = (0, 200, 0)
        elif status == "wrong":
            rgb = (255, 0, 0)
        else:
            rgb = (60, 60, 60)
        squares.append((7, index, rgb))
    return squares


# --- SERIAL COMMAND HANDLER ---
def handle_serial_command(line):
    global last_move, pending_bot_move
    global global_brightness, target_brightness
    global rush_score_active, rush_score_data
    global rush_opponent_active, rush_opponent_squares
    global scan_occupancy_active, scan_occupancy_squares
    global rush_wrong_then_strike

    if not line:
        return

    try:
        data = json.loads(line)
    except Exception as exc:
        print("Invalid JSON:", exc)
        return

    if not isinstance(data, dict):
        return

    command = data.get("cmd")

    try:
        if command == "BLANK":
            stop_illegal_effect()
            stop_animation()
            stop_special_effect()
            stop_rush_breath()

            last_move = None
            pending_bot_move = None
            scan_occupancy_active = False
            scan_occupancy_squares = None

            turn_off_all(announce=False)

        elif command == "NORMAL":
            stop_illegal_effect()
            stop_animation()
            stop_special_effect()
            stop_rush_breath()

            last_move = None
            pending_bot_move = None
            scan_occupancy_active = False
            scan_occupancy_squares = None

            global_brightness = NORMAL_BRIGHTNESS
            target_brightness = NORMAL_BRIGHTNESS

            render_rows(ALL_ROWS)

        elif command == "SETUP":
            setup_board()

        elif command == "READY":
            ready_board()

        elif command == "PENDING":
            show_pending_move(
                data["from"],
                data["to"],
            )

        elif command == "LAST":
            show_last_move(
                data["from"],
                data["to"],
            )

        elif command == "GAME_HIGHLIGHT":
            show_game_highlight(
                data.get("lastFrom"),
                data.get("lastTo"),
                data.get("pendingFrom"),
                data.get("pendingTo"),
            )

        elif command == "CHECK":
            show_check(
                data["kingSquare"]
            )

        elif command == "ILLEGAL":
            show_illegal_move()

        elif command == "LOADING":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()

            play_loading_animation(
                data.get("animation", "vibgyor"),
                data.get("loop", False),
            )

        elif command == "MATCH_FOUND":
            stop_illegal_effect()
            stop_animation()

            start_special_effect(
                build_match_found_flashes()
            )

        elif command == "MATCH_FAILED":
            start_match_failed_effect()

        elif command == "END":
            play_end_animation(
                data.get("result", "draw")
            )

        elif command == "OFF":
            stop_illegal_effect()
            stop_animation()
            stop_special_effect()
            stop_rush_breath()

            turn_off_all(announce=False)

        elif command == "SCAN_OCCUPANCY":
            squares = data.get("squares", [])
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_illegal_effect()
            stop_match_failed_effect()
            stop_animation()
            stop_special_effect()
            rush_score_active = False
            rush_score_data = None
            rush_opponent_active = False
            rush_opponent_squares = None

            coords = []
            for sq in squares:
                r, c = rush_square_rgb(sq)
                coords.append((r, c))

            scan_occupancy_active = True
            scan_occupancy_squares = coords
            render_game_board()

        elif command == "RUSH_SCAN_WAVE":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_illegal_effect()
            stop_special_effect()
            rush_score_active = False
            rush_score_data = None
            rush_opponent_active = False
            rush_opponent_squares = None
            play_loading_animation("scan_wave", True)

        elif command == "RUSH_EMPTY_REQUIRED":
            squares = data.get("squares", [])
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_animation()
            stop_special_effect()
            rush_score_active = False
            rush_opponent_active = False

            clear_frame()
            for square in squares:
                row, col = rush_square_rgb(square)
                paint_square(row, col, RED_RGB)
            send_frame()

        elif command == "RUSH_LOADING":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_special_effect()
            rush_score_active = False
            rush_score_data = None
            rush_opponent_active = False
            rush_opponent_squares = None
            play_loading_animation("vibgyor", False)

        elif command == "RUSH_PIECE_PROMPT":
            squares = data.get("squares")
            if squares is None and data.get("square"):
                squares = [data["square"]]
            show_rush_piece_group(squares or [], tuple(data["rgb"]))

        elif command == "RUSH_PUZZLE_READY":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            rush_score_active = False
            rush_opponent_active = False
            ready_board()

        elif command == "RUSH_CORRECT_MOVE":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_animation()
            stop_special_effect()
            rush_opponent_active = False
            rush_opponent_squares = None

            from_row, from_col = rush_square_rgb(data["from"])
            to_row, to_col = rush_square_rgb(data["to"])

            render_rows(ALL_ROWS)
            paint_square(from_row, from_col, (0, 200, 0))
            paint_square(to_row, to_col, (0, 200, 0))
            send_frame()

        elif command == "RUSH_WRONG_MOVE":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_animation()
            stop_special_effect()
            rush_opponent_active = False
            rush_opponent_squares = None

            pf_r, pf_c = rush_square_rgb(data["playedFrom"])
            pt_r, pt_c = rush_square_rgb(data["playedTo"])
            cf_r, cf_c = rush_square_rgb(data["correctFrom"])
            ct_r, ct_c = rush_square_rgb(data["correctTo"])

            base = chess_pixels(ALL_SQUARES)

            def with_overlay(base_px, targets, rgb):
                tset = set(targets)
                out = [(r, c, col) for (r, c, col) in base_px if (r, c) not in tset]
                for (r, c) in targets:
                    out.append((r, c, rgb))
                return out

            start_special_effect([
                (1600, with_overlay(base, [(pf_r, pf_c), (pt_r, pt_c)], RED_RGB)),
                (200, base),
                (1800, with_overlay(base, [(cf_r, cf_c), (ct_r, ct_c)], (0, 200, 0))),
                (200, base),
            ])

        elif command == "RUSH_SCORE_STRIP":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_animation()
            stop_special_effect()
            rush_opponent_active = False
            rush_opponent_squares = None
            rush_score_active = True
            rush_score_data = data.get("results", [])
            render_game_board()

        elif command == "RUSH_OPPONENT_MOVE":
            stop_rush_prompt()
            stop_rush_strike_lock()
            stop_rush_breath()
            stop_animation()
            stop_special_effect()

            from_row, from_col = rush_square_rgb(data["from"])
            to_row, to_col = rush_square_rgb(data["to"])

            rush_opponent_active = True
            rush_opponent_squares = [
                (from_row, from_col),
                (to_row, to_col),
            ]
            render_game_board()

        elif command == "RUSH_OVER":
            completed = bool(data.get("completed", False))
            rgb = (0, 200, 0) if completed else RED_RGB
            start_rush_breath(rgb, duration_ms=3500)

        else:
            print("Unknown command:", command)

    except Exception as exc:
        print("LED command error:", exc)


# --- MAIN NON-BLOCKING SERIAL LOOP ---
poller = select.poll()
poller.register(sys.stdin, select.POLLIN)


try:
    turn_off_all(announce=False)
    print("LED_SERVER_READY")

    while True:
        for _ in range(64):
            if not poller.poll(0):
                break

            line = sys.stdin.readline()

            if line:
                handle_serial_command(line.strip())

        update_animation()
        update_special_effect()
        update_illegal_effect()
        update_match_failed_effect()
        update_rush_breath_effect()
        update_brightness_transition()

        time.sleep_ms(5)


except KeyboardInterrupt:
    print("\n[LED server interrupted.]")

finally:
    turn_off_all(announce=False)
    sm.active(0)
    Pin(PIN, Pin.OUT).value(0)
    print("\n[All lights turned off. LED server exited.]")