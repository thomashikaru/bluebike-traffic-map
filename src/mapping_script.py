#!/usr/bin/env python3
"""
Bike Route Mapping Script

This script analyzes Bluebikes trip data and creates visualizations of popular routes
using OpenStreetMap data and bike sharing trip records.

Author: Thomas Clark
Date: 2025

Usage: python src/mapping_script.py
"""

import os
import sys
import warnings
from pathlib import Path

# Suppress warnings for cleaner output
warnings.filterwarnings("ignore")

# Import required libraries
import sklearn
import osmnx as ox
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.patches
import seaborn as sns
import numpy as np
from collections import defaultdict


def load_bike_network(
    address="77 Massachusetts Ave, Cambridge, Massachusetts",
    dist=5000,
    network_type="bike",
):
    """
    Load a bike network from OpenStreetMap data around a specific address.

    Args:
        address (str): Address to center the network around
        dist (int): Distance in meters to search around the address
        network_type (str): Type of network to extract ('bike', 'drive', 'walk')

    Returns:
        networkx.MultiDiGraph: The loaded network graph
    """
    print(f"Loading bike network around {address}...")
    G = ox.graph_from_address(
        address, network_type=network_type, dist=dist, dist_type="bbox"
    )
    print(f"Loaded network with {len(G.nodes)} nodes and {len(G.edges)} edges")
    return G


def modify_edge_weights_for_cycling_infrastructure(
    G, cycleway_weight_factor=0.3, bike_friendly_weight_factor=0.7
):
    """
    Modify edge weights to prefer cycling infrastructure.

    This function reduces the weight of edges that have cycling infrastructure,
    making them more preferable in shortest path calculations.

    Args:
        G (networkx.MultiDiGraph): The network graph
        cycleway_weight_factor (float): Weight multiplier for dedicated cycleways (0-1, lower = more preferable)
        bike_friendly_weight_factor (float): Weight multiplier for bike-friendly roads (0-1, lower = more preferable)

    Returns:
        networkx.MultiDiGraph: The modified network graph with updated edge weights
    """
    print("Modifying edge weights for cycling infrastructure preference...")

    # Define cycling infrastructure categories
    dedicated_cycling = ["cycleway", "path"]  # Dedicated cycling infrastructure
    bike_friendly = ["pedestrian", "service", "residential"]  # Bike-friendly but shared

    # Count edges by type for reporting
    edge_counts = defaultdict(int)
    modified_edges = 0

    # Create a copy of the graph to avoid modifying the original
    G_modified = G.copy()

    for u, v, k, data in G_modified.edges(data=True, keys=True):
        highway_type = data.get("highway", "unknown")

        # Handle case where highway_type might be a list
        if isinstance(highway_type, list):
            highway_type = highway_type[0] if highway_type else "unknown"

        edge_counts[highway_type] += 1

        # Get the original length/weight
        original_length = data.get("length", 1.0)

        # Apply weight modifications based on cycling infrastructure
        if highway_type in dedicated_cycling:
            # Dedicated cycling infrastructure gets the lowest weight
            new_weight = original_length * cycleway_weight_factor
            data["length"] = new_weight
            data["original_length"] = original_length  # Store original for reference
            modified_edges += 1

        elif highway_type in bike_friendly:
            # Bike-friendly roads get reduced weight
            new_weight = original_length * bike_friendly_weight_factor
            data["length"] = new_weight
            data["original_length"] = original_length  # Store original for reference
            modified_edges += 1

    print(f"Modified {modified_edges} edges for cycling infrastructure preference")
    print("Edge type distribution:")
    for edge_type, count in sorted(
        edge_counts.items(), key=lambda x: x[1], reverse=True
    ):
        print(f"  {edge_type}: {count}")

    return G_modified


def load_trip_data(filepath):
    """
    Load and preprocess bike trip data from CSV file.

    Args:
        filepath (str): Path to the CSV file containing trip data

    Returns:
        pandas.DataFrame: Processed trip data with datetime and time of day columns
    """
    print(f"Loading trip data from {filepath}...")
    df = pd.read_csv(filepath)

    # Convert timestamp to datetime
    df["started_at"] = pd.to_datetime(df["started_at"])

    # Add time of day classification (AM/PM)
    df["time_of_day"] = df["started_at"].dt.hour.map(lambda x: "AM" if x < 12 else "PM")

    print(f"Loaded {len(df)} trip records")
    return df


def map_stations_to_nodes(df, G):
    """
    Map bike station IDs to network nodes using nearest neighbor search.

    Args:
        df (pandas.DataFrame): Trip data with station coordinates
        G (networkx.MultiDiGraph): Network graph

    Returns:
        pandas.DataFrame: DataFrame with start_node and end_node columns added
    """
    print("Mapping stations to network nodes...")

    # Create mapping from station ID to nearest node
    station_id2node = dict()

    # Get unique stations to avoid redundant calculations
    df_dedup = df.drop_duplicates(subset="start_station_id")

    # Find nearest nodes for each station
    nodes = ox.distance.nearest_nodes(G, df_dedup.start_lng, df_dedup.start_lat)

    # Create mapping dictionary
    for station_id, node in zip(df_dedup.start_station_id, nodes):
        station_id2node[station_id] = int(node)

    # Apply mapping to full dataset
    df["start_node"] = df["start_station_id"].replace(station_id2node)
    df["end_node"] = df["end_station_id"].replace(station_id2node)

    print(f"Mapped {len(station_id2node)} unique stations to network nodes")
    return df


def make_route_map(df, G, top_n=50000):
    """
    Create a mapping of route segments to trip counts.

    Args:
        df (pandas.DataFrame): Trip data with start_node and end_node columns
        G (networkx.MultiDiGraph): Network graph
        top_n (int): Number of top routes to consider

    Returns:
        defaultdict: Mapping of (node1, node2) tuples to trip counts
    """
    print(f"Creating route map for top {top_n} routes...")

    # Group by start and end nodes and count trips
    df_grp = (
        df.dropna()
        .groupby(["start_node", "end_node"])
        .agg({"ride_id": "count"})
        .reset_index()
    )

    # Get top N most popular routes
    df_grp_sub = df_grp.nlargest(top_n, "ride_id")

    # Calculate shortest paths for each route
    df_grp_sub["route"] = ox.routing.shortest_path(
        G, df_grp_sub.start_node, df_grp_sub.end_node
    )

    # Count trips on each edge segment
    route_map = defaultdict(int)

    for _, row in df_grp_sub.iterrows():
        if row["route"] is None or len(row["route"]) <= 1:
            continue

        # Count trips on each edge of the route
        for x, y in zip(row["route"][:-1], row["route"][1:]):
            route_map[(x, y)] += row["ride_id"]

    print(f"Created route map with {len(route_map)} unique edges")
    return route_map


def make_map_data(df, G, cmap_name="rainbow", width_scale=4.0):
    """
    Prepare data for map visualization with colors and widths based on trip density.

    Args:
        df (pandas.DataFrame): Trip data
        G (networkx.MultiDiGraph): Network graph
        cmap_name (str): Name of the color map to use
        width_scale (float): Scaling factor for edge widths

    Returns:
        tuple: (colors, widths, route_map, max_val, cmap) for edge visualization and legend
    """
    print("Preparing map visualization data...")

    # Get route mapping
    route_map = make_route_map(df, G)

    if not route_map:
        print("Warning: No routes found in data")
        return [], [], {}, 0, None

    # Calculate maximum value for normalization
    max_val = max(route_map.values())

    # Create color map
    cmap = sns.color_palette(cmap_name, as_cmap=True)

    # Calculate alpha values (opacity) and colors for each edge
    alphas = [route_map.get((a, b), 0) / max_val for (a, b, _) in G.edges]
    colors = [mcolors.to_hex(cmap(x)) for x in alphas]

    # Calculate widths for each edge
    widths = list(
        width_scale
        * np.array([route_map.get((a, b), 0) / max_val for (a, b, _) in G.edges])
    )

    print(f"Prepared visualization data for {len(colors)} edges")
    return colors, widths, route_map, max_val, cmap


def create_route_visualization(
    G,
    colors,
    widths,
    route_map,
    max_val,
    cmap,
    unique_days,
    output_file="map.pdf",
    bgcolor="black",
    node_color="black",
    node_size=0,
):
    """
    Create and save a route visualization map with colorbar legend.

    Args:
        G (networkx.MultiDiGraph): Network graph
        colors (list): List of colors for edges
        widths (list): List of widths for edges
        route_map (dict): Mapping of edges to trip counts
        max_val (float): Maximum trip count for normalization
        cmap: Color map object
        output_file (str): Output file path
        bgcolor (str): Background color
        node_color (str): Node color
        node_size (int): Node size
    """
    print(f"Creating route visualization with colorbar...")

    # Create the plot with more space for the colorbar
    fig, ax = ox.plot_graph(
        G,
        bgcolor=bgcolor,
        edge_color=colors,
        edge_alpha=1.0,
        edge_linewidth=widths,
        node_color=node_color,
        node_size=node_size,
        figsize=(14, 10),  # Wider figure to accommodate colorbar
    )

    # Add colorbar showing average daily bike traffic
    if cmap is not None and max_val > 0:
        # Calculate average daily trips using actual number of days in dataset
        max_daily_trips = max_val / unique_days

        # Create a scalar mappable for the colorbar
        norm = mcolors.Normalize(vmin=0, vmax=max_daily_trips)
        sm = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
        sm.set_array([])

        # Add colorbar with proper formatting (smaller size)
        cbar = plt.colorbar(sm, ax=ax, fraction=0.023, pad=0.04)  # Half the size
        cbar.set_label(
            "Average Daily Bike Trips",
            fontsize=10,
            color="black",
        )

        # Format tick labels to show reasonable values
        tick_values = np.linspace(0, max_daily_trips, 6)
        tick_labels = [f"{val:.1f}" for val in tick_values]
        cbar.set_ticks(tick_values)
        cbar.set_ticklabels(tick_labels)

        # Ensure tick labels are visible and properly positioned
        cbar.ax.tick_params(
            labelsize=8,
            colors="black",
            direction="out",
            length=4,
            width=1,
        )

        # Make sure the colorbar axis is properly configured
        cbar.ax.yaxis.set_tick_params(pad=10)

        # Force the colorbar to render properly
        cbar.ax.yaxis.set_label_position("right")
        cbar.ax.yaxis.tick_right()

        # Ensure text is visible by setting explicit properties
        for label in cbar.ax.get_yticklabels():
            label.set_color("black")
            label.set_fontsize(8)
            label.set_visible(True)

        # Alternative approach: manually set the tick labels with explicit formatting
        cbar.ax.set_yticklabels(tick_labels, color="black", fontsize=8)

        print(
            f"Added colorbar showing average daily bike trips (max: {max_daily_trips:.1f} trips/day)"
        )

    # Save the figure
    fig.savefig(
        output_file, bbox_inches="tight", dpi=300, facecolor=bgcolor, edgecolor="none"
    )

    # Also save as PNG for better text rendering if needed
    png_file = output_file.replace(".pdf", ".png")
    fig.savefig(
        png_file, bbox_inches="tight", dpi=300, facecolor=bgcolor, edgecolor="none"
    )

    print(f"Saved visualization to {output_file} and {png_file}")


def main():
    """
    Main function to run the bike route analysis and visualization.
    """
    print("=== Bike Route Mapping Analysis ===\n")

    # Configuration
    DATA_FILE = "data/202310-bluebikes-tripdata.csv"
    ADDRESS = "77 Massachusetts Ave, Cambridge, Massachusetts"
    NETWORK_DISTANCE = 5000  # meters
    OUTPUT_FILE = "results/map.pdf"

    # Cycling infrastructure weight factors (0-1, lower = more preferable)
    CYCLEWAY_WEIGHT_FACTOR = 0.5  # Dedicated cycleways get 30% of original weight
    BIKE_FRIENDLY_WEIGHT_FACTOR = 0.75  # Bike-friendly roads get 70% of original weight

    try:
        # Step 1: Load the bike network
        G = load_bike_network(ADDRESS, NETWORK_DISTANCE)

        # Step 2: Modify edge weights for cycling infrastructure preference
        G = modify_edge_weights_for_cycling_infrastructure(
            G,
            cycleway_weight_factor=CYCLEWAY_WEIGHT_FACTOR,
            bike_friendly_weight_factor=BIKE_FRIENDLY_WEIGHT_FACTOR,
        )

        # Step 3: Load trip data
        df = load_trip_data(DATA_FILE)

        # Step 4: Map stations to network nodes
        df = map_stations_to_nodes(df, G)

        # Step 5: Calculate number of unique days in the dataset
        unique_days = df["started_at"].dt.date.nunique()
        print(f"Dataset spans {unique_days} unique days")

        # Step 6: Prepare visualization data
        colors, widths, route_map, max_val, cmap = make_map_data(df, G)

        # Step 7: Create and save visualization
        create_route_visualization(
            G, colors, widths, route_map, max_val, cmap, unique_days, OUTPUT_FILE
        )

        print("\n=== Analysis Complete ===")
        print(f"Output saved to: {OUTPUT_FILE}")
        print(f"Cycling infrastructure preferences applied:")
        print(f"  - Dedicated cycleways: {CYCLEWAY_WEIGHT_FACTOR}x weight reduction")
        print(
            f"  - Bike-friendly roads: {BIKE_FRIENDLY_WEIGHT_FACTOR}x weight reduction"
        )

    except FileNotFoundError as e:
        print(f"Error: Could not find data file: {e}")
        print("Please ensure the data file path is correct.")
    except Exception as e:
        print(f"Error during analysis: {e}")
        raise


if __name__ == "__main__":
    main()
