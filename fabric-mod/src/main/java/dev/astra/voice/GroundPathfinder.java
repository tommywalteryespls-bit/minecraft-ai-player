package dev.astra.voice;

import java.util.*;

/** Incremental local A*: searches loaded ground and returns a useful segment for distant targets. */
final class GroundPathfinder {
    record Cell(int x, int y, int z) { Cell add(int x, int y, int z) { return new Cell(this.x + x, this.y + y, this.z + z); } }
    interface Terrain { double bodyCost(Cell cell); boolean support(Cell cell); }
    private record Node(Cell cell, double score) {}
    static List<Cell> find(Cell start, Cell goal, double radius, Terrain terrain, int budget) {
        var open = new PriorityQueue<Node>(Comparator.comparingDouble(Node::score));
        var cost = new HashMap<Cell, Double>(); var parent = new HashMap<Cell, Cell>(); var closed = new HashSet<Cell>();
        open.add(new Node(start, distance(start, goal))); cost.put(start, 0.0);
        Cell best = start;
        while (!open.isEmpty() && closed.size() < budget) {
            Cell current = open.remove().cell(); if (!closed.add(current)) continue;
            if (distance(current, goal) < distance(best, goal)) best = current;
            if (current.y == goal.y && distance(current, goal) <= radius) { best = current; break; }
            for (int[] offset : new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) for (int dy : new int[]{0,1,-1}) {
                Cell next = current.add(offset[0], dy, offset[1]);
                if (closed.contains(next) || !terrain.support(next.add(0,-1,0))) continue;
                double body = terrain.bodyCost(next) + terrain.bodyCost(next.add(0,1,0));
                if (dy > 0) body += terrain.bodyCost(current.add(0,2,0));
                if (!Double.isFinite(body)) continue;
                double candidate = cost.get(current) + 1 + Math.abs(dy) * 0.5 + body;
                if (candidate >= cost.getOrDefault(next, Double.POSITIVE_INFINITY)) continue;
                parent.put(next, current); cost.put(next, candidate); open.add(new Node(next, candidate + distance(next, goal)));
            }
        }
        if (best.equals(start)) return List.of();
        var path = new ArrayList<Cell>();
        for (Cell next = best; !next.equals(start); next = parent.get(next)) path.add(next);
        Collections.reverse(path); return path;
    }
    private static double distance(Cell a, Cell b) { return Math.abs(a.x-b.x) + Math.abs(a.y-b.y) + Math.abs(a.z-b.z); }
}
