enum Colors { 
    RED = '\x1b[31m',
    GREEN = '\x1b[32m',
    YELLOW = '\x1b[33m',
    BLUE = '\x1b[34m',
    MAGENTA = '\x1b[35m',
    CYAN = '\x1b[36m',
    WHITE = '\x1b[37m',
    RESET = '\x1b[0m'
}

const log = (message: unknown, color?: Colors) => {
    if (color) {
        console.log(color, message, Colors.RESET);
    } else {
        console.log(message, Colors.RESET);
    }
};

export { log, Colors };