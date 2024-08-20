interface Timer {
	callback: () => unknown | Promise<unknown>
	units: "seconds" | "minutes" | "hours" | "days"
	interval: number
	countOfRepeats?: number
}

const mapIntevaltoMilliseconds = (
	interval: number,
	units: "seconds" | "minutes" | "hours" | "days"
) => {
	switch (units) {
		case "seconds":
			return interval * 1000
		case "minutes":
			return interval * 1000 * 60
		case "hours":
			return interval * 1000 * 60 * 60
		case "days":
			return interval * 1000 * 60 * 60 * 24
		default:
			return interval
	}
}

const repeatEvent = (props: Timer) => {
	let count = 0

	const interval = setInterval(() => {
    count++;

		if (props.countOfRepeats) {
			console.log(
				`${props.callback.name}: Call ${count} of ${props.countOfRepeats} time(s)`
			)
    }
    
		props.callback()
    if (props.countOfRepeats && count >= props.countOfRepeats) {
      console.log(`${props.callback.name}: Stopping timer`)
			clearInterval(interval)
		}
	}, mapIntevaltoMilliseconds(props.interval, props.units))

	return interval
}

export default repeatEvent
