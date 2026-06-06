# BlueBike Traffic Map

A data visualization project that analyzes BlueBike trip data to create interactive maps showing bike traffic volume patterns across the Greater Boston area.

## Overview

This project processes BlueBike bike-sharing trip data to visualize popular cycling routes and traffic patterns. Using OpenStreetMap data and routing algorithms, it creates heat maps that show where bike traffic is heaviest, helping to understand urban cycling behavior and infrastructure usage.

For the **interactive web map** (precompute + Leaflet), design decisions and extension notes live in **[HANDOFF.md](HANDOFF.md)**.

## Features

- **Traffic Volume Visualization**: Creates color-coded maps showing bike traffic density
- **Cycling Infrastructure Optimization**: Routes prefer dedicated bike lanes and bike-friendly roads
- **High-Quality Output**: Generates both PDF and PNG formats with professional styling
- **Interactive station map**: Single-page Leaflet map of per-station hourly net flow (arrivals minus departures) by weekday and weekend

## Project Structure

```
bluebike-traffic-map/
├── data/                          # Raw data files
│   └── 202310-bluebikes-tripdata.csv (or .zip)
├── src/                           # Source code
│   ├── mapping_script.py          # OSMnx route heat map script
│   └── build_station_hourly_json.py  # Precompute JSON for the web map
├── web/                           # Static interactive map
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── vendor/chart.umd.min.js    # Chart.js (bundled for offline / reliable load)
│   └── data/stations_hourly.json  # Generated; run precompute to refresh
├── results/                       # Generated visualizations (mapping_script)
├── requirements-precompute.txt   # pandas-only deps for build_station_hourly_json.py
├── HANDOFF.md                     # Design handoff for the web map + precompute pipeline
└── README.md                      # This file
```

## Prerequisites

- Python 3.8+
- Conda environment management
- Internet connection (for downloading OpenStreetMap data)

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd bluebike-traffic-map
   ```

2. **Install required dependencies**:
   ```bash
   pip install pandas numpy matplotlib seaborn scikit-learn osmnx
   ```

## Data Requirements

The project requires BlueBike trip data in CSV format with the following columns:
- `ride_id`: Unique trip identifier
- `started_at`: Trip start timestamp
- `start_station_id`: Starting station ID
- `end_station_id`: Ending station ID
- `start_lat`, `start_lng`: Starting coordinates
- `end_lat`, `end_lng`: Ending coordinates

This data can be downloaded from [https://bluebikes.com/system-data](https://bluebikes.com/system-data) for more up-to-date data. 

## Usage

### Basic Usage

Run the main analysis script:

```bash
python src/mapping_script.py
```

This will:
1. Load the bike network
2. Process the October 2023 BlueBike trip data
3. Generate a traffic volume visualization
4. Save results to `results/map.pdf` and `results/map.png`

### Interactive web map (station net flow)

1. **Create a virtual environment and install precompute dependencies** (recommended on macOS/Homebrew Python):

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements-precompute.txt
   ```

2. **Build `web/data/stations_hourly.json`** from one or more trip CSVs (defaults to `data/202310-bluebikes-tripdata.csv`):

   ```bash
   python3 src/build_station_hourly_json.py
   ```

   Optional arguments: list CSV paths, `-o path/to/output.json`, and `--slots-per-day N` where `N` divides 1440 (default `24` for hourly buckets; e.g. `48` for 30-minute slots). The JSON has separate blocks **`weekday`** and **`weekend`**: for each slot, mean departures, arrivals, and net per active calendar day of that type, plus `expectedMin` / `expectedMax` from mean daily min/max net across slots.

3. **Serve the `web/` directory over HTTP** (needed so the browser can load the JSON):

   ```bash
   cd web && python3 -m http.server 8080
   ```

   Open [http://127.0.0.1:8080/](http://127.0.0.1:8080/) in a browser. Use the time-of-day slider and **Weekday** / **Weekend**; station markers reflect net for the selected day type and slot (Eastern). **Click a station marker** for the 24 h chart (rolling mean); dashed line = current slider time.

### Configuration

The script can be customized by modifying these parameters in `mapping_script.py`:

- `ADDRESS`: Center point for the network (default: MIT campus)
- `NETWORK_DISTANCE`: Search radius in meters (default: 5000m)
- `CYCLEWAY_WEIGHT_FACTOR`: Preference for dedicated bike lanes (0.5 = 50% weight)
- `BIKE_FRIENDLY_WEIGHT_FACTOR`: Preference for bike-friendly roads (0.75 = 75% weight)

## Output

The visualization shows:
- **Color intensity**: Represents average daily bike trips per route segment
- **Line thickness**: Indicates traffic volume
- **Colorbar**: Shows the scale of daily trip counts
- **Black background**: Professional styling for presentations

## Technical Details

### Routing Algorithm

The project uses a modified shortest path algorithm that:
- Prefers dedicated cycling infrastructure (cycleways, paths)
- Favors bike-friendly roads (pedestrian, service, residential)
- Calculates optimal routes between start and end stations
- Aggregates trip counts across route segments

### Data Processing Pipeline

1. **Network Loading**: Downloads OpenStreetMap data for the target area
2. **Weight Modification**: Adjusts edge weights based on cycling infrastructure
3. **Station Mapping**: Maps BlueBike stations to network nodes
4. **Route Calculation**: Computes optimal routes for each trip
5. **Traffic Aggregation**: Counts trips on each network segment
6. **Visualization**: Creates color-coded map with traffic density


## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- BlueBike for providing the trip data
- OpenStreetMap contributors for the street network data
- OSMnx library for network analysis capabilities